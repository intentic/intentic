import {
    CRASH_LOOP_STARTS,
    crashLooping,
    dropKeptCopies,
    HEALTHY_AFTER_MS,
    type KeptCopyIo,
    putBack,
    type StartLedger,
    withCleanExit,
    withStart,
} from "./agent-trial.js";
import { agentPath, asideOf, isLeftover, launcherPath } from "./release.js";

/* WHEN A NEW AGENT IS GIVEN UP ON, asserted over the ledger alone: three starts of one release inside ten minutes, none
   ended by somebody asking, and that release never having stayed up for the ten minutes that prove it. */

const NOW = 1_800_000_000_000;

// `count` starts of `version`, a minute apart, the last one now.
const started = (version: string, count: number, from: StartLedger | undefined = undefined): StartLedger =>
    Array.from({ length: count }, (_, index) => index).reduce<StartLedger | undefined>(
        (ledger, index) => withStart(ledger, version, 100 + index, NOW - (count - 1 - index) * 60_000),
        from,
    ) ?? { version, starts: [] };

test("the third start inside the window, none ended cleanly, is a crash loop; the second is not", () => {
    expect(crashLooping(started("2.0.0", CRASH_LOOP_STARTS - 1), undefined, NOW)).toBe(false);
    expect(crashLooping(started("2.0.0", CRASH_LOOP_STARTS), undefined, NOW)).toBe(true);
});

// Somebody restarting the agent three times after an upgrade is not the agent crashing.
test("a start that ended because it was asked to (stop, restart, upgrade) does not count", () => {
    const ledger = withCleanExit(started("2.0.0", CRASH_LOOP_STARTS), 100);
    expect(crashLooping(ledger, undefined, NOW)).toBe(false);
});

// The ten minutes are the whole proof: a release that once held is not rolled back for crashing later.
test("a release that has already proved itself is never judged a crash loop", () => {
    expect(crashLooping(started("2.0.0", CRASH_LOOP_STARTS + 2), "2.0.0", NOW)).toBe(false);
    expect(crashLooping(started("2.0.0", CRASH_LOOP_STARTS), "1.9.0", NOW)).toBe(true);
});

test("starts older than the window are forgotten, and another release's starts never count", () => {
    const old = withStart(withStart(undefined, "2.0.0", 1, NOW - HEALTHY_AFTER_MS - 60_000), "2.0.0", 2, NOW - HEALTHY_AFTER_MS);
    expect(withStart(old, "2.0.0", 3, NOW)).toEqual({ version: "2.0.0", starts: [{ at: NOW, pid: 3 }] });
    expect(withStart(started("1.9.0", 2), "2.0.0", 3, NOW)).toEqual({ version: "2.0.0", starts: [{ at: NOW, pid: 3 }] });
});

/* THE KEPT COPIES, over a scripted bin/: which files are there, which a running process holds (Windows renames such a
   file but refuses to replace or delete it), which are open without sharing (a scanner's handle: not even renamed), and
   every effect in order. */

const bin = (present: readonly string[], held: { readonly running?: readonly string[]; readonly locked?: readonly string[] } = {}) => {
    const files = new Set(present);
    const running = new Set(held.running);
    const locked = new Set(held.locked);
    const steps: string[] = [];
    const io: KeptCopyIo = {
        exists: (path) => files.has(path),
        rename: async (from, to) => {
            steps.push(`rename ${from} → ${to}`);
            if (!files.has(from)) {
                return await Promise.reject(new Error(`ENOENT: ${from}`));
            }
            if (running.has(to) || locked.has(from)) {
                return await Promise.reject(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`));
            }
            files.delete(from);
            files.add(to);
            return undefined;
        },
        vacate: async (path) => {
            steps.push(running.has(path) ? `set aside ${path}` : `delete ${path}`);
            files.delete(path);
            await Promise.resolve();
        },
        now: () => NOW,
    };
    return { files, steps, io };
};

// The binary an earlier rollback set aside may still be running, so this one never lands on a name it could hold.
test("a rollback sets the current binary aside under a name of its own, never over an `.old` that may still run", async () => {
    const t = bin([agentPath, `${agentPath}.previous`, `${agentPath}.old`], { running: [`${agentPath}.old`] });
    await putBack(agentPath, t.io);
    expect(t.steps).toEqual([`rename ${agentPath} → ${asideOf(agentPath, NOW)}`, `rename ${agentPath}.previous → ${agentPath}`]);
    expect(t.files.has(agentPath) && !t.files.has(`${agentPath}.previous`)).toBe(true);
    expect(isLeftover(asideOf("intentic-machine.exe", NOW))).toBe(true);
});

test("a kept copy that will not go back leaves the current binary where it was, so the path is never empty", async () => {
    const t = bin([agentPath, `${agentPath}.previous`], { locked: [`${agentPath}.previous`] });
    await expect(putBack(agentPath, t.io)).rejects.toThrow("EPERM");
    expect(t.steps.at(-1)).toBe(`rename ${asideOf(agentPath, NOW)} → ${agentPath}`);
    expect(t.files.has(agentPath) && t.files.has(`${agentPath}.previous`)).toBe(true);
});

test("nothing kept is nothing to put back", async () => {
    const t = bin([agentPath]);
    await putBack(agentPath, t.io);
    expect(t.steps).toEqual([]);
});

// (2026-10-21) The keyring's launcher outlived an agent upgrade and ran on from the launcher's `.previous`, which the
// drop could not delete, so the whole drop failed. A held copy is moved aside instead.
test("the drop clears both kept copies, moving one a running process holds aside rather than failing", async () => {
    const t = bin([`${agentPath}.previous`, `${launcherPath}.previous`], { running: [`${launcherPath}.previous`] });
    expect(await dropKeptCopies(t.io)).toBe(2);
    expect(t.steps).toEqual([`delete ${agentPath}.previous`, `set aside ${launcherPath}.previous`]);
    expect(await dropKeptCopies(t.io)).toBe(0);
});
