// A stand-in for OpenClaw's CLI, with just the behaviour the wrapper's boot depends on.
//
// What it imitates is the 2026-10-16 restart of brain-dipp (OpenClaw 2026.9.6):
// `doctor --fix` holds the state directory's lifecycle lock while it repairs,
// and a `gateway run` that finds a state migration pending and the lock taken
// fails with exit 78 ("Gateway failed to start: Doctor could not enter
// maintenance … another OpenClaw process owns gateway-lifecycle").
//
// Knobs, all through the environment:
//   FAKE_DOCTOR_MS       how long doctor --fix takes (default 1500)
//   FAKE_GATEWAY_FAILS   how many `gateway run`s exit 1 before one stays up (default 0)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const state = process.env.OPENCLAW_STATE_DIR;
const lock = path.join(state, ".fake-lifecycle-lock");
const migrated = path.join(state, ".fake-migrated");
const failures = path.join(state, ".fake-gateway-failures");
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (args[0] === "doctor") {
  fs.writeFileSync(lock, String(process.pid));
  await sleep(Number(process.env.FAKE_DOCTOR_MS ?? 1500));
  fs.writeFileSync(migrated, "1");
  fs.rmSync(lock, { force: true });
  console.log("doctor: repaired");
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "stop") process.exit(1);
if (args[0] === "config") process.exit(0);
if (args[0] === "--version") {
  console.log("fake-openclaw 0.0.0");
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "run") {
  if (!fs.existsSync(migrated)) {
    if (fs.existsSync(lock)) {
      console.error("Gateway failed to start: Doctor could not enter maintenance. another OpenClaw process owns gateway-lifecycle");
      process.exit(78);
    }
    fs.writeFileSync(migrated, "1");
  }
  const failed = Number(fs.existsSync(failures) ? fs.readFileSync(failures, "utf8") : "0");
  if (failed < Number(process.env.FAKE_GATEWAY_FAILS ?? 0)) {
    fs.writeFileSync(failures, String(failed + 1));
    await sleep(300);
    console.error("gateway: crashed during startup");
    process.exit(1);
  }
  const port = Number(args[args.indexOf("--port") + 1]);
  // Takes a moment to come up, like the real one, so a probe can catch it not listening yet.
  await sleep(300);
  http.createServer((_req, res) => res.end("fake gateway")).listen(port, "127.0.0.1");
  process.on("SIGTERM", () => process.exit(0));
} else {
  process.exit(0);
}
