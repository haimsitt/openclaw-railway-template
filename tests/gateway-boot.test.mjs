import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The wrapper booted for real, against a fake OpenClaw (fixtures/fake-openclaw.mjs).
 *
 * brain-dipp, 2026-10-16: a reseed restarted the agent service, and chat was
 * down from 13:59:48 to 14:02:22. A request from the brain arrived while the
 * boot-time `doctor --fix` was still running and started the gateway beside
 * it; the gateway found the lifecycle lock taken and exited 78, and the wrapper
 * then sat out its 60-second readiness wait on a process that was already gone
 * before anything started a new one. These tests are that morning in seconds.
 */

const repo = fileURLToPath(new URL("..", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/fake-openclaw.mjs", import.meta.url));
const TOKEN = "test-gateway-token";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function boot(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-boot-"));
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}");
  const port = await freePort();
  let output = "";
  const child = spawn(process.execPath, [path.join(repo, "src", "server.js")], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(port),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKSPACE_DIR: path.join(dir, "workspace"),
      OPENCLAW_ENTRY: fake,
      OPENCLAW_NODE: process.execPath,
      INTERNAL_GATEWAY_PORT: String(await freePort()),
      OPENCLAW_GATEWAY_TOKEN: TOKEN,
      SETUP_PASSWORD: "test",
      RAILWAY_PUBLIC_DOMAIN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // The wrapper's own port is up within a moment; the gateway behind it is the question.
  for (let i = 0; i < 100 && !output.includes("listening on port"); i++) await new Promise((r) => setTimeout(r, 50));
  return { port, output: () => output };
}

/** One proxied request, as the brain sends it; what came back and how long it took. */
async function ask(port, timeoutMs = 15_000) {
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.text(), ms: Date.now() - started };
  } catch (err) {
    return { status: 0, body: String(err), ms: Date.now() - started };
  }
}

test("a request that arrives while doctor is still repairing waits for it, rather than starting a gateway that cannot run", async (t) => {
  const wrapper = await boot(t, { FAKE_DOCTOR_MS: "2000" });
  assert.ok(wrapper.output().includes("running openclaw doctor --fix"), "the request below lands during the repair");

  const answer = await ask(wrapper.port);
  assert.equal(answer.status, 200, `got ${answer.status} after ${answer.ms} ms; wrapper log:\n${wrapper.output().slice(-1500)}`);
  assert.equal(answer.body, "fake gateway");
  assert.ok(answer.ms < 10_000, `answered after ${answer.ms} ms`);
  assert.doesNotMatch(wrapper.output(), /exited code=78/, "the gateway was never started beside the repair");
});

test("a gateway that dies while starting is started again in seconds, not after the 60-second readiness wait", async (t) => {
  const wrapper = await boot(t, { FAKE_DOCTOR_MS: "200", FAKE_GATEWAY_FAILS: "1" });

  const answer = await ask(wrapper.port);
  assert.equal(answer.status, 200, `got ${answer.status} after ${answer.ms} ms; wrapper log:\n${wrapper.output().slice(-1500)}`);
  assert.ok(answer.ms < 10_000, `answered after ${answer.ms} ms`);
  assert.match(wrapper.output(), /exited code=1/, "the first gateway did die");
  assert.doesNotMatch(wrapper.output(), /did not become ready in time/);
});
