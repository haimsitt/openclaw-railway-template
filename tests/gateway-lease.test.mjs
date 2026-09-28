import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gatewayStateDbPath, reclaimForeignGatewayLease } from "../src/gateway-lease.js";

// The table exactly as OpenClaw 2026.9.6 creates it (read from a live state directory).
const SCHEMA = `CREATE TABLE "state_leases" (
  scope TEXT NOT NULL,
  lease_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER,
  heartbeat_at INTEGER,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, lease_key)
) STRICT;`;

function stateDir({ table = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-"));
  const file = gatewayStateDbPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  if (table) db.exec(SCHEMA);
  return { dir, db };
}

function lease(db, { scope = "gateway-owner", key = "global", owner = "o-1", host = "old-box", payload } = {}) {
  const now = Date.now();
  const json = payload ?? JSON.stringify({ owner: { pid: 172, host, startedAt: 1 }, port: 18789, mode: "foreground", supervisor: null });
  db.prepare("INSERT INTO state_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(scope, key, owner, now + 300_000, now - 1000, json, now, now);
}

const rows = (db) => db.prepare("SELECT scope, lease_key, owner FROM state_leases ORDER BY scope").all().map((r) => ({ ...r }));

test("a lease left by another container is removed, and only that row", async () => {
  const { dir, db } = stateDir();
  lease(db, { host: "16febcb4b771" });
  lease(db, { scope: "startup-migration", owner: "o-2", host: "16febcb4b771" });
  const result = await reclaimForeignGatewayLease({ stateDir: dir, hostname: "1abd0f3860eb" });
  assert.equal(result.reclaimed, true);
  assert.equal(result.host, "16febcb4b771");
  assert.match(result.heartbeatAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(rows(db), [{ scope: "startup-migration", lease_key: "global", owner: "o-2" }]);
});

test("this container's own lease is left for OpenClaw to judge", async () => {
  const { dir, db } = stateDir();
  lease(db, { host: "1abd0f3860eb" });
  const result = await reclaimForeignGatewayLease({ stateDir: dir, hostname: "1abd0f3860eb" });
  assert.deepEqual(result, { reclaimed: false, reason: "lease is this container's" });
  assert.equal(rows(db).length, 1);
});

test("a lease whose owner cannot be read is left alone", async () => {
  const { dir, db } = stateDir();
  lease(db, { payload: "not json" });
  assert.deepEqual(await reclaimForeignGatewayLease({ stateDir: dir, hostname: "box" }), { reclaimed: false, reason: "lease names no host" });
  assert.equal(rows(db).length, 1);
});

test("nothing to do: no database, no table, no lease", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lease-"));
  assert.deepEqual(await reclaimForeignGatewayLease({ stateDir: empty, hostname: "box" }), { reclaimed: false, reason: "no state database" });
  assert.deepEqual(await reclaimForeignGatewayLease({ stateDir: stateDir({ table: false }).dir, hostname: "box" }), { reclaimed: false, reason: "no lease table" });
  assert.deepEqual(await reclaimForeignGatewayLease({ stateDir: stateDir().dir, hostname: "box" }), { reclaimed: false, reason: "no gateway lease" });
});

test("a database it cannot open is reported, never thrown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-"));
  fs.mkdirSync(gatewayStateDbPath(dir), { recursive: true }); // a directory where the file should be
  const result = await reclaimForeignGatewayLease({ stateDir: dir, hostname: "box" });
  assert.equal(result.reclaimed, false);
  assert.match(result.reason, /^could not read the lease: /);
});
