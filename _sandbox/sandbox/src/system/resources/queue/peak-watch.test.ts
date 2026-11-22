import { createPeakWatch } from "./peak-watch.js";
import { fakePeakProc, PAGE_BYTES, queuedCmdline } from "./peak-watch.testing.js";

/* What a queued heavy command held at its peak, measured over the process tree queue-run's pid leads once it exec'd into
   the command (2026-11-22, the shinobi-society audit: the test binary `cargo test -p integra-render` ran grew to 13.5
   GB). Every look is taken by hand (sampleMs 0), over a /proc the test edits between looks. */

const KEY = "cargo-verify @shinobi-society: cargo test --lib -p integra-render";
const COMMAND = "cargo test --lib -p integra-render";

// What the watch recorded, in order.
const recorder = () => {
    const recorded: unknown[] = [];
    const record = async (key: string, command: string, peakBytes: number): Promise<void> => {
        recorded.push({ key, command, peakBytes });
    };
    return { recorded, record };
};

test("the peak is the whole tree's, from the exec into the command until it exits, a reparented process included", async () => {
    const { proc, processes } = fakePeakProc();
    processes.set(500, { ppid: 400, start: 10, rssPages: 1_000, cmdline: queuedCmdline("cargo", "test") });
    // Something else entirely, never part of the tree.
    processes.set(600, { ppid: 1, start: 11, rssPages: 9_000_000, cmdline: "llama-server\0" });
    const { record, recorded } = recorder();
    const watch = createPeakWatch({ record, proc, sampleMs: 0 });
    await watch.watch(500, KEY, COMMAND);
    // A second admission of the same process (a wait asked again) adds no second measurement.
    await watch.watch(500, KEY, COMMAND);
    await watch.look();

    // The exec: cargo, then the test binary under rustc's sibling.
    processes.set(500, { ppid: 400, start: 10, rssPages: 5_000, cmdline: "cargo\0test\0" });
    processes.set(501, { ppid: 500, start: 12, rssPages: 100_000, cmdline: "rustc\0" });
    processes.set(502, { ppid: 501, start: 13, rssPages: 2_000_000, cmdline: "integra_render-1f\0" });
    await watch.look();
    // Its parent gone, the binary is reparented to init and still counts, at its new size.
    processes.delete(501);
    processes.set(502, { ppid: 1, start: 13, rssPages: 2_400_000, cmdline: "integra_render-1f\0" });
    await watch.look();
    expect(recorded).toEqual([]);

    processes.delete(500);
    processes.delete(502);
    await watch.look();
    expect(recorded).toEqual([{ key: KEY, command: COMMAND, peakBytes: (5_000 + 2_400_000) * PAGE_BYTES }]);
});

test("a run that never left queue-run (a skipped deadline, a held command not started) records nothing", async () => {
    const { proc, processes } = fakePeakProc();
    processes.set(500, { ppid: 400, start: 10, rssPages: 1_000, cmdline: queuedCmdline("cargo", "test") });
    const { record, recorded } = recorder();
    const watch = createPeakWatch({ record, proc, sampleMs: 0 });
    await watch.watch(500, KEY, COMMAND);
    await watch.look();
    processes.delete(500);
    await watch.look();
    expect(recorded).toEqual([]);
});

test("a pid taken by another process ends the run it was, and the newcomer is never counted", async () => {
    const { proc, processes } = fakePeakProc();
    processes.set(500, { ppid: 400, start: 10, rssPages: 1_000, cmdline: queuedCmdline("cargo", "test") });
    const { record, recorded } = recorder();
    const watch = createPeakWatch({ record, proc, sampleMs: 0 });
    await watch.watch(500, KEY, COMMAND);
    processes.set(500, { ppid: 400, start: 10, rssPages: 3_000, cmdline: "cargo\0test\0" });
    await watch.look();
    processes.set(500, { ppid: 1, start: 99, rssPages: 8_000_000, cmdline: "other\0" });
    await watch.look();
    expect(recorded).toEqual([{ key: KEY, command: COMMAND, peakBytes: 3_000 * PAGE_BYTES }]);
});

test("the process memory-room named is found by its start, in this pid namespace or by its innermost pid in another", async () => {
    const { proc, processes } = fakePeakProc();
    processes.set(500, { ppid: 400, start: 10, rssPages: 1, cmdline: queuedCmdline("cargo", "test") });
    // A jailed turn's queue-run: pid 7 inside its namespace, 700 here.
    processes.set(700, { ppid: 650, start: 42, rssPages: 1, cmdline: queuedCmdline("cargo", "test"), nspid: [700, 7] });
    processes.set(7, { ppid: 1, start: 3, rssPages: 1, cmdline: "sshd\0" });
    const watch = createPeakWatch({ record: async () => undefined, proc, sampleMs: 0 });
    expect(await watch.resolve(500, 10)).toBe(500);
    expect(await watch.resolve(7, 42)).toBe(700);
    expect(await watch.resolve(7, 43)).toBeUndefined();
});
