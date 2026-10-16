// When the recovery panel shows, and what it prints: the ways back for a sandbox that didn't come back, which must work
// with that sandbox's daemon down. It shows when the diagnosis found a way back, never on a timer. The commands are
// pinned in their published spelling, since that is what a reader on another machine pastes.
import { scriptSource } from "../../../app/environments/scriptCommand";
import type { DiagnosisNotice } from "../diagnosis/presentation";
import { recoveryCommands, recoveryDue, type RecoveryInput, RESTART_RECOVERY_AFTER_MS } from "./recovery";

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
    sayAtOnce: false,
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

    it(`spells each single-purpose command as the one-liner for the shell of the machine it is for`, () => {
        expect(recoveryCommands(`sandbox-3c469e9d6c58`, `unix`)).toEqual({
            rollback: `curl -fsSL https://intentic.dev/rollback/sandbox-3c469e9d6c58 | sh`,
            restart: `curl -fsSL https://intentic.dev/restart/sandbox-3c469e9d6c58 | sh`,
        });
        expect(recoveryCommands(`sandbox-3c469e9d6c58`, `windows`)).toEqual({
            rollback: `irm https://intentic.dev/rollback/sandbox-3c469e9d6c58 | iex`,
            restart: `irm https://intentic.dev/restart/sandbox-3c469e9d6c58 | iex`,
        });
    });

    it(`falls back to ic's bare verbs when nothing here knows the sandbox's name`, () => {
        expect(recoveryCommands(undefined, `windows`)).toEqual({ rollback: `ic sandbox rollback`, restart: `ic sandbox restart` });
        expect(recoveryCommands(`Not a slug`, `unix`)).toEqual({ rollback: `ic sandbox rollback`, restart: `ic sandbox restart` });
    });
});
