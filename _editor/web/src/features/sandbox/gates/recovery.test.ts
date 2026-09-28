// When the recovery panel shows, and what it prints: the ways back for a sandbox that didn't come back, which must work
// with that sandbox's daemon down. The commands are pinned in their published spelling, since that is what a reader on
// another machine pastes.
import { installScriptUrl } from "@intentic/constants";
import type { Device } from "@intentic/sandbox-contract";
import { scriptSource } from "../../../app/environments/scriptCommand";
import { listedDevice } from "../../../testing/listedDevice";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { RECOVERY_AFTER_MS, recoveryCommands, recoveryDue, type RecoveryInput, RESTART_RECOVERY_AFTER_MS, siblingManagers } from "./recovery";

const quiet: RecoveryInput = {
    failure: { kind: `network`, message: `Failed to fetch` },
    reachable: false,
    outageMs: RECOVERY_AFTER_MS,
    restartExpected: false,
    removed: false,
    refused: false,
    hosted: false,
    canRollBack: false,
    owner: true,
};

describe(`when the panel is due`, () => {
    it(`shows for the owner's own sandbox two minutes into a silence, and not a moment before`, () => {
        expect(recoveryDue(quiet)).toBe(true);
        expect(recoveryDue({ ...quiet, outageMs: RECOVERY_AFTER_MS - 1 })).toBe(false);
        expect(RECOVERY_AFTER_MS).toBe(120_000);
    });

    it(`gives a restart this browser asked for three minutes before calling it one that didn't come back`, () => {
        expect(recoveryDue({ ...quiet, restartExpected: true, outageMs: RECOVERY_AFTER_MS })).toBe(false);
        expect(recoveryDue({ ...quiet, restartExpected: true, outageMs: RESTART_RECOVERY_AFTER_MS })).toBe(true);
        expect(RESTART_RECOVERY_AFTER_MS).toBe(180_000);
    });

    it(`covers every shape silence takes, the edge's own "no tunnel" included`, () => {
        for (const kind of [`network`, `timeout`, `closed`, `detached`] as const) {
            expect(recoveryDue({ ...quiet, failure: { kind, message: `` } })).toBe(true);
        }
    });

    it(`stands down where it has nothing to offer or another screen says more`, () => {
        expect(recoveryDue({ ...quiet, reachable: true })).toBe(false);
        expect(recoveryDue({ ...quiet, owner: false })).toBe(false);
        expect(recoveryDue({ ...quiet, removed: true })).toBe(false);
        expect(recoveryDue({ ...quiet, refused: true })).toBe(false);
        expect(recoveryDue({ ...quiet, failure: { kind: `unauthenticated`, message: `` } })).toBe(false);
        expect(recoveryDue({ ...quiet, failure: undefined })).toBe(false);
        // A hosted sandbox has no machine of the owner's to type on: only the platform's rollback, when it kept an image.
        expect(recoveryDue({ ...quiet, hosted: true })).toBe(false);
        expect(recoveryDue({ ...quiet, hosted: true, canRollBack: true })).toBe(true);
    });
});

describe(`what it prints`, () => {
    beforeEach(() => {
        scriptSource.value = `published`;
    });

    it(`spells each command in the shell of the machine it is for`, () => {
        const update = installScriptUrl(`update`);
        expect(recoveryCommands(`sandbox-3c469e9d6c58`, `unix`)).toEqual({
            rollback: `curl -fsSL ${update} | sh -s -- sandbox-3c469e9d6c58 --rollback`,
            restart: `curl -fsSL ${update} | sh -s -- sandbox-3c469e9d6c58 --restart`,
            doctor: `curl -fsSL ${update} | sh -s -- sandbox-3c469e9d6c58 --doctor`,
        });
        const updatePs1 = installScriptUrl(`updatePs1`);
        expect(recoveryCommands(`sandbox-3c469e9d6c58`, `windows`)).toEqual({
            rollback: `& ([scriptblock]::Create((irm ${updatePs1}))) -Slug sandbox-3c469e9d6c58 -Rollback`,
            restart: `& ([scriptblock]::Create((irm ${updatePs1}))) -Slug sandbox-3c469e9d6c58 -Restart`,
            doctor: `& ([scriptblock]::Create((irm ${updatePs1}))) -Slug sandbox-3c469e9d6c58 -Doctor`,
        });
    });

    it(`falls back to ic's bare verbs when nothing here knows the sandbox's name`, () => {
        expect(recoveryCommands(undefined, `windows`)).toEqual({ rollback: `ic sandbox rollback`, restart: `ic sandbox restart`, doctor: `ic sandbox doctor` });
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
