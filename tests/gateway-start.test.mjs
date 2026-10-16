import test from "node:test";
import assert from "node:assert/strict";
import { restartDelayMs, waitForReady } from "../src/gateway-start.js";

/** A clock that only moves when the code under test sleeps, so a 60-second wait takes no time. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms), elapsed: () => t };
}

test("ready as soon as the gateway answers", async () => {
  const c = clock();
  let probes = 0;
  const outcome = await waitForReady({ probe: async () => ++probes === 3, alive: () => true, timeoutMs: 60_000, ...c });
  assert.equal(outcome, "ready");
  assert.equal(c.elapsed(), 500, "two quarter-second waits, then the answer");
});

test("a process that is gone is reported at once, not at the deadline", async () => {
  const c = clock();
  let alive = true;
  const outcome = await waitForReady({
    probe: async () => {
      alive = false; // it dies while the first probe is in flight
      return false;
    },
    alive: () => alive,
    timeoutMs: 60_000,
    ...c,
  });
  assert.equal(outcome, "exited");
  assert.equal(c.elapsed(), 0);
});

test("a gateway that stays up but never answers times out", async () => {
  const c = clock();
  const outcome = await waitForReady({ probe: async () => false, alive: () => true, timeoutMs: 60_000, ...c });
  assert.equal(outcome, "timeout");
  assert.equal(c.elapsed(), 60_000);
});

test("restarts back off from 2 s and never wait more than a minute", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(restartDelayMs), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(restartDelayMs(0), 2000, "a count that was never incremented still waits the base delay");
});
