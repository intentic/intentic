import type { HostCrashEvent } from "@intentic/sandbox-contract/schemas/hosts";
import type { PostMortem } from "../../resources/memory-records.js";
import { BOOT_AT, CULPRIT, NIGHT_SUMMARY, STARTED_AT } from "./memory-incident.testing.js";
import { CRASH_REPORTED_WITHIN_MS, crashesDuring, describePreviousRun, endedUncleanly, hostCrashText, previousRunOf, restartCost, RUN_ENDINGS } from "./restart-record.js";

const BOOT = "2026-11-02T19:36:45.094Z";
const crash = (at: string, kind: HostCrashEvent["kind"], code: string): HostCrashEvent => ({ id: `${code}@${at}`, at, kind, code });
const reset = crash("2026-11-02T19:30:52.000Z", "gpu-reset", "LiveKernelEvent 141");
const powerOff = crash("2026-11-02T19:35:10.000Z", "host-crash", "Kernel-Power 41");

test("a run's crashes are those from its start to just after the boot that followed it", () => {
    const late = crash(new Date(Date.parse(BOOT) + CRASH_REPORTED_WITHIN_MS + 1).toISOString(), "gpu-reset", "Display 4101");
    const before = crash("2026-11-02T18:00:00.000Z", "host-crash", "Kernel-Power 41");
    expect(crashesDuring([before, reset, powerOff, late], "2026-11-02T18:43:11.917Z", BOOT)).toEqual([reset, powerOff]);
});

// rog, 2026-11-02: the restart said only "killed without warning".
test("a run killed without warning is said to have died with its host, by Windows' own codes", () => {
    expect(describePreviousRun({ ended: "killed", graceful: false }, [powerOff, reset])).toBe(
        "was killed when the computer it runs on went down after a GPU reset: Windows reported its GPU reset at 2026-11-02T19:30:52.000Z (LiveKernelEvent 141); it went down at 2026-11-02T19:35:10.000Z (Kernel-Power 41)",
    );
    expect(hostCrashText([reset])).toBe("was killed without warning while the computer it runs on had a GPU reset: Windows reported its GPU reset at 2026-11-02T19:30:52.000Z (LiveKernelEvent 141)");
});

test("a run that ended any other way keeps its own account, crashes or not", () => {
    expect(describePreviousRun({ ended: "stopped", graceful: true, signal: "SIGTERM" }, [powerOff])).toContain("stopped gracefully on SIGTERM");
    expect(describePreviousRun({ ended: "killed", graceful: false })).toContain("was killed without warning (");
});

// 2026-11-05: the boot after a 1 h 48 m thrash said only "killed without warning", for five turns nobody could account for.
const night: PostMortem = { cause: "memory", killed: [], netd: [], culprits: [CULPRIT], summary: NIGHT_SUMMARY };

test("a kill the post-mortem named is said by its cause, in place of the five-way guess", () => {
    const previous = previousRunOf({ marker: { state: "running", pid: 65, startedAt: STARTED_AT }, intent: undefined, now: BOOT_AT, postMortem: night, namedEnding: "netd-stuck" });
    expect(previous).toMatchObject({ ended: "netd-stuck", graceful: false, postMortem: night });
    expect(describePreviousRun(previous)).toBe(`was killed: ${NIGHT_SUMMARY}`);
    expect(describePreviousRun(previous)).not.toContain("SIGKILL, a kernel OOM kill");
    // The note a resumed turn reads names it too.
    expect(restartCost({ ...previous, containerRestarted: false })).toContain(`The run before it was killed: ${NIGHT_SUMMARY}.`);
    // Killed with memory killed around it, by a hand nothing names: said as such.
    expect(describePreviousRun({ ended: "killed", graceful: false, postMortem: night })).toBe(`was killed without warning while memory ran out: ${NIGHT_SUMMARY}`);
});

test("a named ending refines only a kill, and without its post-mortem still says who did it", () => {
    const refine = (marker: Parameters<typeof previousRunOf>[0]["marker"]): string => previousRunOf({ marker, intent: undefined, now: BOOT_AT, namedEnding: "oom-victim" }).ended;
    expect(refine({ state: "running", pid: 65, startedAt: STARTED_AT })).toBe("oom-victim");
    expect(refine({ state: "exited", pid: 65, startedAt: STARTED_AT, exitCode: 0, graceful: true })).toBe("stopped");
    expect(refine(undefined)).toBe("unknown");
    expect(describePreviousRun({ ended: "netd-stuck", graceful: false })).toBe(
        "was killed by netd, which found it not answering (an event loop stopped for five minutes, or a start that never said hello)",
    );
    expect(describePreviousRun({ ended: "oom-victim", graceful: false })).toBe("was killed by the kernel's OOM killer, which chose the daemon itself");
});

test("a post-mortem with no named cause narrows the guess, and one around a crash is said beside it", () => {
    const nothing: PostMortem = { cause: "unknown", killed: [], netd: [], culprits: [], summary: "nothing on file names the hand: no process was killed for memory" };
    expect(describePreviousRun({ ended: "killed", graceful: false, postMortem: nothing })).toBe(
        "was killed without warning (SIGKILL, a kernel OOM kill, a forced container stop, netd killing a stuck daemon, or the host going down); nothing on file names the hand: no process was killed for memory",
    );
    expect(describePreviousRun({ ended: "crashed", graceful: false, exitCode: 1, postMortem: night })).toMatch(/^crashed: exited with code 1 .*; netd killed the daemon after/u);
});

test("every ending in which the daemon never ran its exit hook is unclean", () => {
    expect(RUN_ENDINGS.filter((ended) => endedUncleanly(ended))).toEqual(["killed", "netd-stuck", "oom-victim", "unknown"]);
    expect(endedUncleanly(undefined)).toBe(false);
});
