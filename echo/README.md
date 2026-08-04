# Echo — sound-based precision meetup finder

Find each other precisely in a crowd — festival, delivery pickup, large
plaza — using only the microphone and speaker every phone already has.
No GPS, no special hardware, and it works across iPhone and Android
equally (unlike Apple's UWB Precision Finding, which is iPhone-only).

This is a single-page web app: HTML/CSS/JS, Web Audio API +
`getUserMedia`. No backend, no accounts, nothing persisted — the two
phones talk to each other directly, over sound, in physical proximity.

## Running it

Serve the `echo/` folder over HTTPS (or `localhost` for same-machine
testing) — browsers refuse `getUserMedia` on plain HTTP. Any static file
server works, e.g.:

```sh
cd echo
python3 -m http.server 8000
# then open https://<your-machine>:8000 or tunnel it (e.g. ngrok) for
# two separate phones to share the same URL
```

Open the URL on both phones (or two tabs on one device for a first
smoke test — see below), pick a role on each, and follow the on-screen
steps.

## The protocol (round-trip chirp ranging)

There are two roles, chosen once per device per session: **Seeker** and
**Responder**.

1. The **Seeker** taps **Ping**. The app plays a short, near-inaudible
   tone burst (~19 kHz, ~80 ms, with a fade-in/out envelope so it
   doesn't click) and starts a high-resolution timer
   (`performance.now()`).
2. The **Responder** listens continuously via the mic. The instant it
   sees a strong signal at ~19 kHz, it plays back its own tone burst —
   at a *different* frequency, ~20 kHz. Using a distinct reply
   frequency means the Seeker can't confuse the tail of its own
   emitted tone with the actual reply.
3. The **Seeker** listens for the ~20 kHz reply. On detection, it stops
   the timer — that elapsed time is the round-trip time (RTT).
4. Distance is derived from RTT, corrected for hardware latency (see
   Calibration below) and converted from a round trip to a one-way
   distance at the speed of sound:

   ```
   distance ≈ ((RTT − calibrationOffset) / 1000) × 343 m/s / 2
   ```

Both roles run the same continuous-listening detection loop; only the
Seeker also drives the ping timer and distance math.

## Calibration — don't skip it

Every phone's audio hardware has different input/output processing
latency (buffering, drivers, codecs), and that latency will otherwise
dominate the measurement — it's typically tens of milliseconds, versus
a few milliseconds of actual sound travel time at meetup-finding
distances.

Before first use:

1. Hold both phones touching each other (true distance ≈ 0).
2. On the Seeker phone, tap **Calibrate** — this runs the exact same
   ping protocol, but stores the resulting RTT as `calibrationOffset`
   instead of computing a distance.
3. Every subsequent **Ping** subtracts that offset before converting to
   distance.

`calibrationOffset` lives only in an in-memory JS variable — **not**
`localStorage`/`sessionStorage`, since that breaks in some embedded /
artifact contexts. It resets every time the page reloads, by design:
recalibrate each session.

## Signal detection

- An `AnalyserNode` (FFT size 4096) reads the mic input.
- `getUserMedia` explicitly disables `echoCancellation`,
  `noiseSuppression`, and `autoGainControl` — the default processing
  pipeline is tuned for voice and will distort or suppress a narrow
  ultrasonic band.
- Detection = the FFT bin(s) nearest 19 kHz / 20 kHz spike above a
  magnitude threshold (0–255 scale from `getByteFrequencyData`).
  The threshold is tunable live via the debug panel's slider — real
  devices vary enough in mic sensitivity that you'll want to tune this
  empirically rather than trust a hardcoded value.
- The Responder debounces for 300 ms after each reply, so it doesn't
  re-trigger on the room echo/reverb of its own reply tone.

## Debug panel

Tap **🐞 Debug** (bottom-right) to reveal: last raw RTT, current
calibration offset, live FFT magnitude at both target frequencies, and
the detection threshold slider. Hidden by default; a **Stop mic/speaker
session** button there fully releases the microphone and resets state.

## Testing strategy

Start with a **same-device loopback test** before you involve a second
phone: open two browser tabs (or two windows) on one machine, set one
to Seeker and the other to Responder. The speaker output of one tab is
picked up by the shared microphone almost instantly, which is a good
first check that the detection and reply logic works end-to-end before
acoustic coupling, ambient noise, and two different pieces of hardware
enter the picture.

Once that works, move to two separate physical phones for a real test.

## Known limitations (read before you trust the number on screen)

- **Accuracy is realistically 1–3 meters, not centimeters.** Browser
  audio buffering adds latency noise that a `performance.now()` timer
  can't fully cancel out. This is a proximity/"getting warmer" aid, not
  survey-grade positioning.
- **Effective range is roughly 5–10 meters** in quiet conditions, and
  degrades in loud, crowded, or echoey environments (concerts, plazas
  with hard reflective surfaces, wind).
- **No directional bearing in this version** — you get distance only,
  not "which way to walk." True bearing needs multiple synchronized
  mics and native-level audio access, which isn't available to a web
  page. That's a stretch goal for a native app version.
- **Ultrasonic signals have a bad reputation** from covert ad-tracking
  beacons (e.g. SilverPush). Echo is the opposite of that on purpose:
  the mic/speaker activation state is always visible on screen while
  active, everything is strictly session-based and opt-in (pick a role
  to start, nothing runs before that), and nothing runs in the
  background — closing or backgrounding the tab stops it.

## File structure

```
/echo
  index.html   # markup: role picker, Seeker/Responder UI, debug panel
  style.css    # styling
  app.js       # audio protocol, role state machine, UI wiring
  README.md    # this file
```
