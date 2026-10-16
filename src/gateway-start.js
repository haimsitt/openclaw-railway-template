/**
 * Waiting for the gateway, and how soon to try again when it dies.
 *
 * Until 2026-10-16 the wrapper waited for readiness by polling the gateway's
 * port for up to 60 s, whether or not the process it had started was still
 * there. When that process died on its first second (brain-dipp, a reseed:
 * exit 78, a state migration blocked by the boot-time doctor), every caller
 * sat out the full minute on a gateway that no longer existed, and nothing
 * started a new one until the minute was up. Checking liveness on every round
 * is what turns that minute into the time a restart actually takes.
 */

/** Before restart attempt `n` (1-based): 2 s, 4 s, 8 s … at most 60 s, so a gateway that keeps dying is not respawned in a hot loop. */
export function restartDelayMs(attempt) {
  return Math.min(2000 * 2 ** Math.max(0, attempt - 1), 60_000);
}

/**
 * Resolves "ready" once `probe()` says the gateway answers, "exited" as soon
 * as `alive()` says the process being waited for is gone, or "timeout".
 * `alive` is checked before each probe, so an exit is noticed within one
 * interval rather than at the deadline.
 */
export async function waitForReady({ probe, alive, timeoutMs, intervalMs = 250, now = Date.now, sleep = defaultSleep }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!alive()) return "exited";
    if (await probe()) return "ready";
    if (!alive()) return "exited";
    await sleep(intervalMs);
  }
  return "timeout";
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
