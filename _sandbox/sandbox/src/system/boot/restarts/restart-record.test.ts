import type { HostCrashEvent } from "@intentic/sandbox-contract/schemas/hosts";
import { CRASH_REPORTED_WITHIN_MS, crashesDuring, describePreviousRun, hostCrashText } from "./restart-record.js";

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
