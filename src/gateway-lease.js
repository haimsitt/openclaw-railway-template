import fs from "node:fs";
import path from "node:path";

/**
 * OpenClaw (2026.9.x) records which process owns the gateway as a row in its
 * state database, renewed every 30 s and valid for 5 min. A redeploy kills
 * the old container without releasing it, and the new container's gateway
 * cannot tell whether a process on another hostname is alive, so it refuses
 * to start ("Another Gateway owner lease is still active for this state
 * directory") until the row expires — up to five minutes with no agent.
 *
 * On Railway a volume is mounted by one container at a time, so a lease
 * written from any other hostname belongs to a container that no longer
 * runs. That row is removed before the gateway starts. A lease from this
 * container is left alone: OpenClaw already reclaims one whose process died.
 */

/** OpenClaw's own key for the row (`gatewayOwnerKey`): one gateway per state directory. */
const SCOPE = "gateway-owner";
const KEY = "global";

export function gatewayStateDbPath(stateDir) {
  return path.join(stateDir, "state", "openclaw.sqlite");
}

/**
 * Returns what was done, for the log: `{ reclaimed: false, reason }` or
 * `{ reclaimed: true, host, heartbeatAt }`. Never throws — a lease it cannot
 * read is OpenClaw's to refuse, exactly as before.
 */
export async function reclaimForeignGatewayLease({ stateDir, hostname }) {
  const file = gatewayStateDbPath(stateDir);
  if (!fs.existsSync(file)) return { reclaimed: false, reason: "no state database" };
  let db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(file, { timeout: 5000 });
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'state_leases'").get();
    if (!table) return { reclaimed: false, reason: "no lease table" };
    const row = db.prepare("SELECT owner, payload_json, heartbeat_at FROM state_leases WHERE scope = ? AND lease_key = ?").get(SCOPE, KEY);
    if (!row) return { reclaimed: false, reason: "no gateway lease" };
    let host = null;
    try {
      host = JSON.parse(row.payload_json)?.owner?.host ?? null;
    } catch {
      host = null;
    }
    if (typeof host !== "string" || !host) return { reclaimed: false, reason: "lease names no host" };
    if (host === hostname) return { reclaimed: false, reason: "lease is this container's" };
    // Keyed on the owner read above, so a lease taken in between is never the one removed.
    const result = db.prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ? AND owner = ?").run(SCOPE, KEY, row.owner);
    if (Number(result.changes) === 0) return { reclaimed: false, reason: "lease changed hands" };
    return { reclaimed: true, host, heartbeatAt: new Date(Number(row.heartbeat_at)).toISOString() };
  } catch (err) {
    return { reclaimed: false, reason: `could not read the lease: ${err.message}` };
  } finally {
    db?.close();
  }
}
