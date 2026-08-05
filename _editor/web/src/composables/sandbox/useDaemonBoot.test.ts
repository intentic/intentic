import type { BootProgress } from "@intentic/sandbox-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { bootStartedAt, bootSteps, daemonReady, resetDaemonBoot, setDaemonBoot } from "./useDaemonBoot";

const progress = (ready: boolean, ...steps: BootProgress["steps"]): BootProgress => ({ ready, startedAt: 1_000, steps });

describe(`useDaemonBoot`, () => {
    beforeEach(() => resetDaemonBoot());

    it(`assumes ready before the daemon has said anything`, () => {
        // The pre-connect state. Assuming NOT ready here would gate every query on a fact nobody has reported,
        // which is a workspace that never opens.
        expect(daemonReady.value).toBe(true);
        expect(bootSteps.value).toEqual([]);
        expect(bootStartedAt.value).toBeUndefined();
    });

    it(`assumes ready from a daemon too old to report a boot at all`, () => {
        // Silence is not evidence of a warm-up — such a daemon behaves exactly as it did before the frame.
        setDaemonBoot(undefined);
        expect(daemonReady.value).toBe(true);
    });

    it(`holds reads while the daemon reports a chain still converging`, () => {
        setDaemonBoot(progress(false, { key: `registry`, label: `Loading conversations`, state: `running` }));
        expect(daemonReady.value).toBe(false);
        expect(bootSteps.value).toEqual([{ key: `registry`, label: `Loading conversations`, state: `running` }]);
        expect(bootStartedAt.value).toBe(1_000);
    });

    it(`releases them the moment the gate opens`, () => {
        setDaemonBoot(progress(false, { key: `registry`, label: `Loading conversations`, state: `running` }));
        setDaemonBoot(progress(true, { key: `registry`, label: `Loading conversations`, state: `done`, ms: 42 }));
        expect(daemonReady.value).toBe(true);
        expect(bootSteps.value[0]?.ms).toBe(42);
    });

    it(`treats a failed step as finished, not as a reason to keep waiting`, () => {
        // The daemon's chain is log-and-continue: a failed step degrades one subsystem and the gate still opens.
        setDaemonBoot(progress(true, { key: `sshHosts`, label: `Linking ssh hosts`, state: `failed`, ms: 3 }));
        expect(daemonReady.value).toBe(true);
    });

    it(`forgets the previous sandbox's boot on switch`, () => {
        setDaemonBoot(progress(false, { key: `registry`, label: `Loading conversations`, state: `running` }));
        resetDaemonBoot();
        // Another sandbox is on its own clock — carrying this over would gate a daemon that is long since up.
        expect(daemonReady.value).toBe(true);
        expect(bootSteps.value).toEqual([]);
    });
});
