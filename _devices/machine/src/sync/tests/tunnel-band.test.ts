import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { SSH_PORT_BASE, SSH_PORT_SPAN, syncSshPort } from "../tunnel.js";

/* The sync SSH band is recorded beside the daemon's loopback band in sandbox-run's names.fixture.json, which the
daemon's own derivation and the Rust readers are tested against. These constants are held to that record, so the two
bands can only move together with it. */

// SAFETY: the fixture is this repository's own file, and the assertions below fail on any field it lacks.
const SHARED = JSON.parse(
    readFileSync(join(repoRoot(import.meta.url), "_shared/sandbox-run/src/names.fixture.json"), "utf8"),
) as { portBands: { syncSsh: { base: number; span: number }; daemonLoopback: { base: number; span: number } } };

test("the sync SSH band is the one names.fixture.json records", () => {
    expect({ base: SSH_PORT_BASE, span: SSH_PORT_SPAN }).toEqual(SHARED.portBands.syncSsh);
});

test("a native environment's port lands inside that band, at both of its ends", () => {
    const native = { wsl: false, name: "" } as const;
    expect(syncSshPort("000000aaaaaa", native)).toBe(SHARED.portBands.syncSsh.base);
    // 0x000f9f = 3999, the last offset the span allows.
    expect(syncSshPort("000f9faaaaaa", native)).toBe(SHARED.portBands.syncSsh.base + SHARED.portBands.syncSsh.span - 1);
});

test("the sync band ends where the daemon's loopback band could begin, never inside it", () => {
    const { syncSsh, daemonLoopback } = SHARED.portBands;
    expect(syncSsh.base + syncSsh.span).toBeLessThanOrEqual(daemonLoopback.base);
});
