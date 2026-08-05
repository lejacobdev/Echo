# Echo — find each other by sound

Echo lets two people find each other precisely in a crowd — a festival, a
plaza, a delivery pickup — using only the microphone and speaker every phone
already has. No GPS, no special chips, and it works identically on iPhone,
Android and desktop (unlike Apple's UWB Precision Finding, which is
iPhone-only).

It ships as an installable **PWA** (one codebase for every OS) backed by a
**zero-dependency Node server** that adds accounts, friends, meetup codes and
realtime session coordination. The acoustic core also works fully **offline
with no account** ("Nearby mode").

## Feature overview

**Acoustic ranging**
- Round-trip ultrasonic chirp ranging (protocol below) with live distance dial,
  warmer/colder trend, proximity bands, and an expanding-ring ping animation
- Guided 5-round calibration wizard (median of successful rounds)
- Single-shot **Ping** and continuous **Live** auto-ping tracking
- Adaptive noise-floor detection threshold (manual override in settings)
- Two frequency channels — A: 19/20 kHz, B: 17.5/18.5 kHz for hardware that
  rolls off near 20 kHz; automatic fallback when the mic's sample rate can't
  support channel A
- Outlier-rejecting smoothing (rolling median + EMA)
- Haptic feedback, optional audible ticks (accessibility), screen wake lock

**Long range (GPS), then precision (sound)** — meetup mode only
- A GPS phase for the gap acoustic ranging can't cover: both phones share
  live position over the meetup's WebSocket room, computing great-circle
  distance and compass bearing between them (haversine + initial bearing,
  `public/js/geo.js`, unit tested)
- Honest about GPS uncertainty by design: shows a combined accuracy radius
  (root-sum-square of both devices' reported accuracy) rather than a falsely
  precise single number
- **Auto-switches between GPS and Precision find** as the distance changes,
  with hysteresis so it doesn't flap back and forth near the boundary: once
  the distance-minus-accuracy margin drops to 15m the Precision (sound) card
  becomes primary (GPS visually demotes but keeps tracking in the
  background, in case you're wrong and still too far); it only switches back
  to GPS-primary once you drift back out past 25m. If you're already
  calibrated when it switches to sound, Live continuous ping starts
  automatically too; if you drift back apart, Live stops rather than
  wasting pings at a range acoustic can't realistically cover
- Compass arrow rotates with device heading when available (`deviceorientation`
  / iOS's `webkitCompassHeading`, permission-gated on iOS 13+); falls back to
  a north-up arrow with a visible note when no heading is available
- Deliberately **not available in Nearby mode** — it needs the peer channel
  that the no-account offline mode doesn't have. Also needs its own
  microphone-independent permission (location), requested explicitly by a
  visible "Enable GPS" tap, never silently

**Social layer** (optional — requires an account)
- Accounts: scrypt-hashed passwords, session cookies, change password, delete
  account; profile with display name + emoji avatar
- Friends: search, requests (send/accept/decline), remove, block/unblock,
  live online status
- Meetups: one-tap "Find" invites to online friends (realtime via WebSocket),
  shareable 6-character codes, deep links (`/j/CODE`), QR codes (generated
  in-house, zero deps), guest joining without an account
- Live sessions: **bidirectional ranging** — both phones simultaneously Seek
  and Respond (server-assigned complementary channels prevent collisions), so
  nobody waits passively and each side gets its own live reading; preset
  quick messages ("I'm here", "On my way", …), found-each-other celebration,
  meetup history
- System notifications for invites when the tab is in the background

**Platform**
- Installable PWA: manifest, service worker (offline app shell — Nearby mode
  works with no connection), generated icons incl. maskable + Apple touch
- i18n: English, Deutsch, Français, Español (auto-detected, switchable)
- Dark/light theme (auto/manual), reduced-motion support, safe-area insets
- Mic/speaker activity is always visible in the header; audio is analyzed
  on-device and never recorded or uploaded

**Server** (plain Node ≥ 18, no runtime dependencies)
- Static hosting + REST API + hand-rolled RFC 6455 WebSocket hub
- Presence tracking, meetup rooms, invite delivery
- Security: CSP + security headers, Origin-checked CSRF protection, SameSite
  cookies, scrypt password hashing, timing-safe comparison, rate-limited auth,
  path-traversal protection, body-size limits
- JSON-file store with atomic debounced writes (swap in a real DB behind
  `server/store.js` when you outgrow it)

## Quick start

```sh
node server/server.js          # or: npm start
# → http://localhost:8080
```

No build step, no npm install needed to run (dev dependencies are only for
tests). Open the URL on two devices, or use two browser tabs for a first
loopback test.

> **Phones require HTTPS for microphone access.** Put the server behind a TLS
> proxy (Caddy, nginx, a PaaS) or a tunnel (`ngrok http 8080`) and share that
> URL. `localhost` works without TLS for same-machine testing.

Environment variables: `PORT` (default 8080), `HOST` (default 0.0.0.0),
`ECHO_DATA` (path to the JSON data file, default `data/echo-data.json`).

## How the ranging protocol works

**Meetup mode is bidirectional**: both phones are simultaneously Seeker and
Responder — nobody waits passively, and each side gets its own continuously
updating reading. This needs a way to stop the two devices' own outbound
pings from colliding on the same frequency, which is what the two frequency
channels are actually for: on joining a meetup room, the server assigns each
device a complementary channel (creator gets A, the other gets B). Each
device then:

1. **Seeks on its own channel** — plays a short (~80 ms) near-inaudible sine
   burst at that channel's *seek* frequency, with a fade-in/out envelope to
   avoid clicks, and starts a timer.
2. **Simultaneously Responds on the *other* channel** — listens continuously
   for the other device's seek frequency and instantly replies with a burst
   at that channel's *reply* frequency the moment it's heard.
3. Accepts a reply only on the frequency it actually transmitted on (its own
   channel's reply frequency), so the two devices' independent round trips
   never get confused for each other's — verified directly in
   `tests/bidirectional.test.js`, which drives two sessions through a
   simulated simultaneous ping with the "air" between them wired together in
   code.

**Nearby mode has no pairing channel** to auto-assign complementary
channels, so it keeps the original either/or role picker instead — pick
**Seeker** on one phone and **Responder** on the other by hand, same as
before, to avoid two devices pinging on the same frequency and colliding.

Either way, detection uses an `AudioWorklet` (or `AnalyserNode` fallback,
see below) with `echoCancellation`/`noiseSuppression`/`autoGainControl` all
disabled — voice processing would suppress the narrow ultrasonic band. A
350 ms debounce stops a Responder re-triggering on room echo. Once a Seeker
hears its reply, it stops the timer — that's the round-trip time (RTT) — and
distance follows:

   ```
   distance ≈ ((RTT − calibrationOffset) / 1000) × 343 m/s ÷ 2
   ```

**Calibration matters.** Audio I/O latency (buffers, drivers, codecs) is tens
of milliseconds and differs per device pair — it would dominate the actual
acoustic travel time (~2.9 ms per meter of separation). Calibration runs the
same protocol 5 times with the phones touching (distance ≈ 0) and stores the
median RTT as the offset for the session. In meetup mode, tap Calibrate on
*both* phones while they're touching — since both devices seek on their own
channel simultaneously, each one independently measures and stores its own
offset in the same round of touching, rather than needing a separate pass
per device.

The detection threshold adapts to the ambient noise floor at each target
frequency (slow EMA, frozen during spikes so chirps don't inflate it); the
diagnostics panel (Settings → "Show diagnostics panel") exposes raw RTT,
offset, live magnitudes and the effective threshold, plus a manual threshold
slider for tuning on unusual hardware.

**Detection runs on an `AudioWorklet`**, not the UI thread. Everything that
turns a chirp into an RTT — the frequency-energy check, threshold crossing,
and its timestamp — happens inside `ranging-worklet.js`, a processor running
on the browser's dedicated real-time audio thread, using a
[Goertzel](https://en.wikipedia.org/wiki/Goertzel_algorithm) detector tuned
to the exact seek/reply frequencies rather than the nearest bin of a
general-purpose FFT. This matters for two concrete reasons:
- **Accuracy**: timestamps come from the AudioContext's own clock
  (`ctx.currentTime`), sampled every ~2.7 ms render quantum — not from
  `requestAnimationFrame`, which ticks at best every ~16.7 ms and gets
  throttled to roughly 1 fps the instant the tab loses foreground focus
  (switching apps, a notification, iPad Split View). That throttling was
  previously capable of injecting multiple *seconds* of apparent RTT noise.
- **Sensitivity**: an exact-frequency check has better SNR than reading off
  a quantized FFT bin grid, so weak/far-away signal stays detectable a bit
  longer as range increases.

Falls back automatically to the original `requestAnimationFrame` +
`AnalyserNode` polling loop on the rare browser without `AudioWorklet`
support (`public/js/goertzel.js` holds the reference implementation, unit
tested with synthetic tones in `tests/goertzel.test.js`; the worklet embeds
an identical, self-contained copy since Safari's `audioWorklet.addModule()`
compatibility is best with no cross-file imports).

**A Responder always listens on both frequency channels at once**, regardless
of what its own local "Frequency channel" setting says. Only a Seeker's
channel choice matters — it decides which frequency *it* transmits and
listens for a reply on (`ranging.js`'s `FREQ_SLOTS`, a fixed 4-frequency
index used consistently by both the worklet and the fallback path). Channel
selection is per-device and there's no cross-device sync — without this, two
phones with mismatched Settings would ping and listen on entirely different
frequencies and never hear each other at all.

## Honest limitations

- **Accuracy is realistically 1–3 m**, not centimeters — browser audio
  buffering adds jitter that calibration can't fully cancel. Echo is a
  proximity/"getting warmer" aid, not survey equipment.
- **Range is roughly 5–10 m** in quiet conditions; loud, crowded or echoey
  environments reduce it.
- **Distance only, no bearing** — direction-finding needs multiple
  synchronized microphones and native audio access; that's a stretch goal for
  a native build.
- **Some hardware can't do 19–20 kHz** (many laptops, older phones). Channel B
  (17.5/18.5 kHz) helps at the cost of being faintly audible to young ears.
- **iPhone silent switch** can mute web audio — the app shows a hint on iOS.
- **No frequency choice gets acoustic ranging to tens of meters in a loud
  venue**, and this isn't a tunable limitation — it's a transducer-power
  problem. A phone speaker outputs roughly 80-85dB SPL at 10cm and loses
  ~6dB per doubling of distance; a loud concert runs 90-110dB ambient. No
  frequency closes that gap. This is why the GPS long-range phase exists:
  GPS distance/bearing covers the gap acoustic physically can't, handing off
  to sound once you're within its real envelope.
- **GPS accuracy degrades indoors, in covered arenas/stadiums, and near tall
  buildings** (multipath, weak/blocked sky view) — the app shows a combined
  accuracy radius rather than a bare number for exactly this reason. Dense
  crowds of people affect it far less than the venue's structure does.
- **Compass heading is approximate** — phone magnetometers are easily thrown
  off by nearby speakers, amps, and metal structures, all common at a venue.
  Falls back to a north-up arrow when no heading is available.
- Ultrasound earned a bad reputation from covert ad-tracking beacons
  (SilverPush et al.). Echo is deliberately the opposite: strictly opt-in,
  session-only, never in the background, with mic/speaker state always
  visible on screen and zero audio recording or upload.

## Architecture

```
server/
  server.js     # HTTP server: static files, security headers, SPA fallback
  api.js        # REST API (auth, friends, meetups, settings)
  ws.js         # RFC 6455 WebSocket codec + presence hub + meetup rooms
  auth.js       # scrypt hashing, sessions, rate limiting
  store.js      # JSON-file store with atomic debounced writes
public/
  index.html    # app shell — all views, strict-CSP compatible
  css/app.css   # design system: dark/light, mobile-first, no frameworks
  js/
    main.js     # boot, hash router, state, presence socket, modals, toasts
    find.js     # find-session controller (local + meetup modes)
    social.js   # auth, friends, history, settings, join views
    ranging.js  # protocol state machine + pure math (unit-tested in node)
    audio.js    # AudioEngine: mic, worklet wiring, tone/tick synthesis
    ranging-worklet.js  # AudioWorkletProcessor: real-time-thread detection
    goertzel.js # exact-frequency energy detector, shared/tested reference
    geo.js      # GPS long-range math: haversine distance, bearing (tested)
    net.js      # fetch wrapper, reconnecting WebSocket, safe storage
    i18n.js     # EN/DE/FR/ES dictionaries + translation helpers
    qr.js       # QR generator (byte mode, ECC-L, v1–5), zero deps
  sw.js         # service worker: precached shell, offline nearby mode
  manifest.webmanifest, icons/
tools/
  generate-icons.js  # renders the PNG icon set from scratch (node:zlib)
  e2e-smoke.mjs      # full-flow browser test (requires Playwright)
tests/               # node --test: API+WS integration, ranging math, QR
```

The WebSocket protocol: clients connect to `/ws` (presence, signed-in users)
or `/ws?code=XXXXXX` (meetup rooms, cookie- or guest-token-authenticated).
Rooms hold max two members, each assigned a complementary transmit channel
(A/B) on join rather than a role — everyone is simultaneously Seeker and
Responder. Rooms relay `phase`/`gps`/`quick`/`found` messages and write
meetup history on end.

## Testing

```sh
npm install        # dev deps (jsqr for QR verification)
npm test           # unit + integration tests (node --test)
node tools/e2e-smoke.mjs       # browser E2E: accounts, friends, meetups
node tools/e2e-gps-smoke.mjs   # browser E2E: two pinned GPS fixes ~44m apart,
                                # verifies live distance/bearing over the WS relay
```

The QR generator is verified by decoding its output with an independent
decoder (jsQR); the WebSocket server is tested with a from-scratch masked
client; ranging math (median, RTT→distance, channel selection, smoothing,
proximity bands) is unit-tested; GPS math (haversine, bearing, the
switch-to-acoustic heuristic) is unit-tested; **bidirectional collision
safety is unit-tested directly** (`tests/bidirectional.test.js`) by driving
two `RangingSession`s through a simulated simultaneous ping with the "air"
between them wired together in pure JS — no browser needed to prove the
protocol logic itself never confuses one device's own ping for the other's
reply. CI runs on Node 18/20/22.

For the acoustic path itself, do a **two-tab loopback test** on one machine
(one tab Seeker, one Responder in Nearby mode — the shared mic hears both
tones), then move to two physical phones in meetup mode. Real-device tuning
lives in the diagnostics panel.

## Deploying / app stores

- Any Node host works: `node server/server.js` behind TLS. State is one JSON
  file (`ECHO_DATA`); mount it on a persistent volume.
- **iOS/Android**: users install the PWA from the browser ("Add to Home
  Screen") — it runs standalone with the app icon and splash colors. For app
  store distribution, wrap the same `public/` bundle with
  [Capacitor](https://capacitorjs.com) (WebView shell) — no code changes
  needed; native wrappers also unlock the multi-mic bearing stretch goal.
- Account recovery (email reset) intentionally isn't included — it would
  require an email provider; wire one into `server/api.js` if you need it.
