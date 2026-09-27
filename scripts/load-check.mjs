#!/usr/bin/env node
/* global process, console, fetch, performance */
/**
 * Load check (PRD 9: "Common list/detail actions within 2 seconds at p95
 * under agreed pilot load").
 *
 *   LOAD_EMAIL=... LOAD_PASSWORD=... node scripts/load-check.mjs [baseUrl] [concurrency] [seconds]
 *
 * Signs in once, then keeps `concurrency` virtual staff busy for `seconds`
 * with the reads the front desk does all day: the lead board, a lead, the
 * inbox, the calendar week, notes and activity. Run it against staging, never
 * production. Exits non-zero if p95 is over 2 s or more than 1% of requests fail.
 */
const base = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const concurrency = Number(process.argv[3] ?? 20);
const seconds = Number(process.argv[4] ?? 30);
const { LOAD_EMAIL, LOAD_PASSWORD } = process.env;
if (!LOAD_EMAIL || !LOAD_PASSWORD) {
  console.error("Set LOAD_EMAIL and LOAD_PASSWORD (a staging account, never a real person's).");
  process.exit(2);
}

const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: LOAD_EMAIL, password: LOAD_PASSWORD }),
});
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (!login.ok || !cookie) {
  console.error(`Sign-in failed (${login.status}).`);
  process.exit(2);
}
const get = (path) => fetch(`${base}${path}`, { headers: { cookie } });

const board = await (await get("/leads?limit=100")).json();
const leadIds = (board.items ?? []).map((l) => l.id);
const today = new Date();
const from = new Date(today.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
const to = new Date(today.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);

const scenarios = [
  ["lead board", () => "/leads?limit=100"],
  ["lead detail", () => (leadIds.length ? `/leads/${leadIds[Math.floor(Math.random() * leadIds.length)]}` : "/leads?limit=1")],
  ["lead timeline", () => (leadIds.length ? `/leads/${leadIds[Math.floor(Math.random() * leadIds.length)]}/timeline` : "/leads?limit=1")],
  ["inbox", () => "/conversations?view=open"],
  ["calendar week", () => `/appointments?from=${from}&to=${to}&includeCanceled=false`],
  ["notes", () => "/notes?limit=40"],
  ["activity", () => "/activities?limit=50"],
];

const timings = Object.fromEntries(scenarios.map(([name]) => [name, []]));
let failures = 0;
let total = 0;
const deadline = Date.now() + seconds * 1000;

async function worker() {
  while (Date.now() < deadline) {
    const [name, path] = scenarios[Math.floor(Math.random() * scenarios.length)];
    const started = performance.now();
    try {
      const r = await get(path());
      await r.arrayBuffer();
      if (!r.ok) failures += 1;
    } catch {
      failures += 1;
    }
    timings[name].push(performance.now() - started);
    total += 1;
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const all = Object.values(timings).flat();
console.log(`\n${total} requests, ${concurrency} concurrent users, ${seconds}s → ${(total / seconds).toFixed(0)} req/s, ${failures} failed\n`);
console.log("scenario".padEnd(16), "count".padStart(7), "p50 ms".padStart(8), "p95 ms".padStart(8), "max ms".padStart(8));
for (const [name, arr] of Object.entries(timings)) {
  console.log(name.padEnd(16), String(arr.length).padStart(7), pct(arr, 50).toFixed(0).padStart(8), pct(arr, 95).toFixed(0).padStart(8), Math.max(0, ...arr).toFixed(0).padStart(8));
}
const p95 = pct(all, 95);
const failRate = failures / Math.max(1, total);
console.log(`\noverall p95 ${p95.toFixed(0)} ms (gate 2000), failure rate ${(failRate * 100).toFixed(2)}% (gate 1%)`);
const pass = p95 <= 2000 && failRate <= 0.01;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
