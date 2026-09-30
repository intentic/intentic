// When the recovery panel shows, and what it prints: the ways back for a sandbox that didn't come back, which must work
// with that sandbox's daemon down. It shows when the diagnosis found a way back, never on a timer. The commands are
// pinned in their published spelling, since that is what a reader on another machine pastes.
import { installScriptUrl } from "@intentic/constants";
import type { Device } from "@intentic/sandbox-contract";
import { scriptSource } from "../../../app/environments/scriptCommand";
import { listedDevice } from "../../../testing/listedDevice";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import type { DiagnosisNotice } from "../diagnosis/presentation";
import { recoveryCommands, recoveryDue, type RecoveryInput, RESTART_RECOVERY_AFTER_MS, siblingManagers } from "./recovery";

// A diagnosis with a way back: the owner's own machine is not connected, and the command is the thing to do.
const wayBack: DiagnosisNotice = {
    title: `acme isn't connected`,
    body: `Its computer may be off.`,
    waiting: false,
    tone: `warning`,
    chain: [],
    action: `fix`,
    otherActions: [],
    findings: [],
};

const quiet: RecoveryInput = {
    reachable: false,
    outageMs: 100_000,
    restartExpected: false,
    removed: false,
    refused: false,
    owner: true,
    notice: wayBack,
};

describe(`when the panel is due`, () => {
    it(`shows as soon as the diagnosis finds a way back, whatever the clock says`, () => {
        expect(recoveryDue(quiet)).toBe(true);
        expect(recoveryDue({ ...quiet, outageMs: 0 })).toBe(true);
    });

    // The false alarm the panel used to be: two minutes of silence from a sandbox that was only busy.
    it(`never shows for a wait, however long it lasts`, () => {
        const busy: DiagnosisNotice = { ...wayBack, waiting: true, tone: `info`, action: undefined, otherActions: [`fix`] };
        expect(recoveryDue({ ...quiet, notice: busy, outageMs: 60 * 60_000 })).toBe(false);
        expect(recoveryDue({ ...quiet, notice: undefined })).toBe(false);
    });

    it(`shows for what the machine reported even when there is nothing to press here`, () => {
        const findings: DiagnosisNotice[`findings`] = [{ id: `disk`, label: `Free disk space`, state: `fail`, fix: `you` }];
        expect(recoveryDue({ ...quiet, notice: { ...wayBack, action: undefined, findings } })).toBe(true);
    });

    it(`gives a restart this browser asked for three minutes before calling it one that didn't come back`, () => {
        expect(recoveryDue({ ...quiet, restartExpected: true, outageMs: RESTART_RECOVERY_AFTER_MS - 1 })).toBe(false);
        expect(recoveryDue({ ...quiet, restartExpected: true, outageMs: RESTART_RECOVERY_AFTER_MS })).toBe(true);
        expect(RESTART_RECOVERY_AFTER_MS).toBe(180_000);
    });

    it(`stands down where it has nothing to offer or another screen says more`, () => {
        expect(recoveryDue({ ...quiet, reachable: true })).toBe(false);
        expect(recoveryDue({ ...quiet, owner: false })).toBe(false);
        expect(recoveryDue({ ...quiet, removed: true })).toBe(false);
        expect(recoveryDue({ ...quiet, refused: true })).toBe(false);
    });
});

describe(`what it prints besides the one command`, () => {
    beforeEach(() => {
        scriptSource.value = `published`;
    });

    it(`spells each single-purpose command in the shell of the machine it is for`, () => {
        const update = installScriptUrl(`update`);
        expect(recoveryCommands(`sandbox-3c469e9d6c58`, `unix`)).toEqual({
            rollback: `curl -fsSL ${update} | sh -s -- sandbox-3c469e9d6c58 --rollback`,
            restart: `curl -fsSL ${update} | sh -s -- sandbox-3c469e9d6c58 --restart`,
        });
        const updatePs1 = installScriptUrl(`updatePs1`);
        expect(recoveryCommands(`sandbox-3c469e9d6c58`, `windows`)).toEqual({
            rollback: `& ([scriptblock]::Create((irm ${updatePs1}))) -Slug sandbox-3c469e9d6c58 -Rollback`,
            restart: `& ([scriptblock]::Create((irm ${updatePs1}))) -Slug sandbox-3c469e9d6c58 -Restart`,
        });
    });

    it(`falls back to ic's bare verbs when nothing here knows the sandbox's name`, () => {
        expect(recoveryCommands(undefined, `windows`)).toEqual({ rollback: `ic sandbox rollback`, restart: `ic sandbox restart` });
    });
});

describe(`another sandbox that can reach the same machine`, () => {
    const rog = (over: Partial<Device> = {}): Device =>
        listedDevice({
            key: `rog`,
            label: `rog`,
            hostId: `rog`,
            online: true,
            sandboxes: [{ slug: `sandbox-3c469e9d6c58`, container: `intentic-sandbox-sandbox-3c469e9d6c58`, running: false, image: `intentic/sandbox:stable`, parked: true }],
            ...over,
        });
    const lab = sandboxSummary({ id: `lab`, name: `Lab` });

    it(`names the owner's sandbox whose Devices page has a live door onto the machine holding this one`, () => {
        expect(siblingManagers([{ sandbox: lab, devices: [rog()] }], `sandbox-3c469e9d6c58`)).toEqual([{ sandbox: lab, machineKey: `rog`, machineLabel: `rog` }]);
    });

    it(`names none that could not press anything there`, () => {
        // A door that is offline, a machine that doesn't hold this sandbox, a sandbox that is only shared with the owner.
        expect(siblingManagers([{ sandbox: lab, devices: [rog({ online: false })] }], `sandbox-3c469e9d6c58`)).toEqual([]);
        expect(siblingManagers([{ sandbox: lab, devices: [rog()] }], `sandbox-other`)).toEqual([]);
        expect(siblingManagers([{ sandbox: sandboxSummary({ id: `shared`, role: `maintainer` }), devices: [rog()] }], `sandbox-3c469e9d6c58`)).toEqual([]);
        expect(siblingManagers([{ sandbox: lab, devices: [rog()] }], undefined)).toEqual([]);
    });
});
