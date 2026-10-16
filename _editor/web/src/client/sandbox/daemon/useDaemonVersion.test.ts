import { resetSandboxScope } from "@intentic/extension-api";
import { OLDEST_SUPPORTED_DAEMON } from "@intentic/sandbox-contract/state/daemon-floor";
import { daemonTooOld, daemonVersion, oldestSupportedDaemon, setDaemonVersion } from "./useDaemonVersion";

describe(`useDaemonVersion`, () => {
    beforeEach(() => resetSandboxScope());

    it(`knows no version, and calls nothing too old, before a hello has said one`, () => {
        expect([daemonVersion.value, daemonTooOld.value]).toEqual([undefined, false]);
    });

    it(`reads the version off the head of the hello's build`, () => {
        setDaemonVersion(`1.337.0:1760000000000`);
        expect([daemonVersion.value, daemonTooOld.value]).toEqual([`1.337.0`, false]);
    });

    it(`calls a release below the floor too old, and the floor itself supported`, () => {
        setDaemonVersion(`1.248.0:1760000000000`);
        expect(daemonTooOld.value).toBe(true);
        setDaemonVersion(`${OLDEST_SUPPORTED_DAEMON}:1760000000000`);
        expect(daemonTooOld.value).toBe(false);
        expect(oldestSupportedDaemon).toBe(OLDEST_SUPPORTED_DAEMON);
    });

    // A checkout's build never checks for updates and has nothing to update to; saying it is too old would lock a
    // developer out of their own sandbox.
    it(`never calls a build from a checkout too old`, () => {
        setDaemonVersion(`0.0.0:1760000000000`);
        expect([daemonVersion.value, daemonTooOld.value]).toEqual([`0.0.0`, false]);
    });

    it(`reads no age from a folder on this computer, which ships with this page`, () => {
        setDaemonVersion(`1.0.0:1`, `folder`);
        expect([daemonVersion.value, daemonTooOld.value]).toEqual([undefined, false]);
    });

    it(`reads a hello with no build as no evidence, and carries nothing across a switch`, () => {
        setDaemonVersion(`1.0.0:1`);
        setDaemonVersion(undefined);
        expect(daemonTooOld.value).toBe(false);
        setDaemonVersion(`1.0.0:1`);
        resetSandboxScope();
        expect(daemonTooOld.value).toBe(false);
    });
});
