import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NETD_KILLS_FILE, type NetdKill } from "../../resources/memory-records.js";
import { NO_HELLO_DEADLINE_MS, neverStartedBoots, readMemoryTrail } from "./memory-trail.js";

/* What a stop left in netd's records, read back at the next boot: rotated, torn, or not there at all. */

const MINUTE = 60_000;
const NOW = 1_793_852_538_000;

test("netd's records are read from the rotated file on, a torn line skipped, a missing file an empty trail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-trail-"));
    try {
        const kill = (at: number): NetdKill => ({ at, kind: "no-hello", pid: at, silentMs: 3 * MINUTE });
        await writeFile(join(dir, `${NETD_KILLS_FILE}.1`), `${JSON.stringify(kill(1))}\n`);
        await writeFile(join(dir, NETD_KILLS_FILE), `${JSON.stringify(kill(2))}\n{"at":3,"kind":"no-he\n${JSON.stringify({ at: 4, kind: "unheard-of" })}\n${JSON.stringify(kill(5))}\n`);
        const trail = readMemoryTrail(dir);
        expect(trail.netd).toEqual({ rows: [kill(1), kill(2), kill(5)] });
        expect(trail.kills).toEqual({ rows: [] });
        expect(trail.pressure).toEqual({ rows: [] });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a boot netd killed before its hello is the boot it ended, never the one before a daemon that recorded nothing", () => {
    const stuckRun = NOW - 120 * MINUTE;
    // netd starts the next daemon a moment after it killed the last one.
    const failed = [NOW - 9 * MINUTE, NOW - 6 * MINUTE + 5_000];
    const kills: NetdKill[] = [
        { at: stuckRun + 21 * MINUTE, kind: "stuck", pid: 65, silentMs: 5 * MINUTE },
        ...failed.map((at): NetdKill => ({ at: at + 3 * MINUTE, kind: "no-hello", pid: 100, silentMs: 3 * MINUTE + 2_000 })),
        // A daemon that never even recorded its boot: its kill must not land on the boot before it.
        { at: NOW - 1 * MINUTE, kind: "no-hello", silentMs: 3 * MINUTE },
    ];
    expect([...neverStartedBoots([stuckRun, ...failed], kills)].toSorted((a, b) => a - b)).toEqual(failed);
    // Without its own silentMs, netd's deadline stands in for it.
    expect([...neverStartedBoots([NOW - 2 * MINUTE], [{ at: NOW, kind: "no-hello" }])]).toEqual([NOW - 2 * MINUTE]);
    expect([...neverStartedBoots([NOW - NO_HELLO_DEADLINE_MS - MINUTE], [{ at: NOW, kind: "no-hello" }])]).toEqual([]);
});
