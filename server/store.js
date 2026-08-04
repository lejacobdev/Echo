// JSON-file-backed data store with atomic, debounced writes.
// Zero external dependencies: good enough for a single-node deployment;
// swap for a real database behind the same interface when you outgrow it.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DATA = () => ({
  users: {},        // id -> user record
  sessions: {},     // token -> { userId, at, exp }
  requests: [],     // { id, from, to, at }
  friendships: [],  // { a, b, at }  (a < b)
  blocks: [],       // { by, target, at }
  meetups: {},      // code -> meetup record
  history: {},      // userId -> [entries]
});

export function createStore(dataFile) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });

  let data;
  try {
    data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch {
    data = DEFAULT_DATA();
  }
  for (const [k, v] of Object.entries(DEFAULT_DATA())) {
    if (data[k] === undefined) data[k] = v;
  }

  let timer = null;
  let writing = Promise.resolve();

  function flush() {
    timer = null;
    const snapshot = JSON.stringify(data);
    writing = writing.then(() => new Promise((resolve) => {
      const tmp = `${dataFile}.tmp`;
      fs.writeFile(tmp, snapshot, (err) => {
        if (!err) fs.rename(tmp, dataFile, () => resolve());
        else resolve();
      });
    }));
  }

  return {
    data,
    save() {
      if (!timer) timer = setTimeout(flush, 250);
    },
    async close() {
      if (timer) { clearTimeout(timer); flush(); }
      await writing;
    },
  };
}

export function pairKey(a, b) {
  return a < b ? { a, b } : { a: b, b: a };
}
