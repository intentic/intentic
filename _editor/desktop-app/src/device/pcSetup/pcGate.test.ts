import { pcGate, type PcGateInput } from "./pcGate";

// Whether a setup handed over runs now, waits for the PC check, or waits for this PC's own setup (onboarding.rs).

const windows = (check: PcGateInput[`check`], dockerReady?: boolean): PcGateInput => ({ os: `windows`, dockerReady, check });

describe(`a setup handed over to this PC`, () => {
    it(`runs at once anywhere but Windows, whatever the check says`, () => {
        expect(pcGate({ os: `linux`, dockerReady: false, check: `needsSetup` })).toBe(`go`);
        expect(pcGate({ os: `macos`, dockerReady: undefined, check: undefined })).toBe(`go`);
    });

    it(`waits for a check that has not answered, rather than reading its silence as a go-ahead`, () => {
        expect(pcGate(windows(undefined))).toBe(`checking`);
        expect(pcGate(windows(`checking`))).toBe(`checking`);
        // The OS is the app's own: an unknown one is not Windows, and runs as before.
        expect(pcGate({ os: undefined, dockerReady: undefined, check: undefined })).toBe(`go`);
    });

    it(`waits for this PC's own setup when the check says it is needed`, () => {
        expect(pcGate(windows(`needsSetup`))).toBe(`needsSetup`);
        expect(pcGate(windows(`needsSetup`, false))).toBe(`needsSetup`);
    });

    it(`runs once Docker answers, whoever installed it, whatever an older check says`, () => {
        expect(pcGate(windows(`needsSetup`, true))).toBe(`go`);
        expect(pcGate(windows(undefined, true))).toBe(`go`);
    });

    it(`runs once this PC's own setup says it is done, whatever the check made before it said`, () => {
        expect(pcGate({ ...windows(`needsSetup`), pcSetup: `ready` })).toBe(`go`);
        expect(pcGate({ ...windows(`needsSetup`), pcSetup: `running` })).toBe(`needsSetup`);
        expect(pcGate({ ...windows(undefined), pcSetup: `waiting` })).toBe(`checking`);
    });

    it(`runs on a ready PC, and on one the check could not read or that cannot run a sandbox: its own prepare says why`, () => {
        expect(pcGate(windows(`ready`))).toBe(`go`);
        expect(pcGate(windows(`unknown`))).toBe(`go`);
        expect(pcGate(windows(`cantRun`))).toBe(`go`);
    });
});
