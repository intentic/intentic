import { ref } from "vue";
import { finishOnHome } from "../../../models/sandbox/finishOnHome";
import {
    finishAskedBy,
    machineAskedBy,
    markReady,
    newSandboxDialogShown,
    newSandboxNote,
    newSandboxPageShown,
    newSandboxPhase,
    newSandboxShownBy,
    newSandboxTileShown,
    readySandboxes,
    seenReady,
    tierAskedBy,
    type NewSandboxFacts,
} from "./newSandbox";

const facts = (overrides: Partial<NewSandboxFacts> = {}): NewSandboxFacts => ({
    pressed: true,
    opening: false,
    started: `here`,
    refused: false,
    machineFailed: false,
    hostedFailed: false,
    report: undefined,
    ...overrides,
});

describe(`the new sandbox's address`, () => {
    it(`is Home asking for it, and nothing else`, () => {
        expect(newSandboxShownBy({ name: `home`, query: { add: `sandbox` } })).toBe(true);
        expect(newSandboxShownBy({ name: `home`, query: {} })).toBe(false);
        expect(newSandboxShownBy({ name: `home`, query: { show: `models` } })).toBe(false);
        // The workspace taking the same query is the shell's to send to Home, not Home showing it.
        expect(newSandboxShownBy({ name: `agents`, query: { add: `sandbox` } })).toBe(false);
    });
});

// A run as its host publishes it, as much of it as the dialog, the page and the tile decide on.
const runOf = (state: { pressed: boolean; started?: `here` | `hosted`; resumed?: boolean }) => ({
    pressed: ref(state.pressed),
    resumed: ref(state.resumed ?? false),
    here: { add: { started: ref(state.started === undefined ? undefined : { kind: state.started }) } },
});

describe(`what Home shows of the new sandbox`, () => {
    const asked = { name: `home`, query: { add: `sandbox` } };
    const chat = { name: `home`, query: {} };

    it(`asks for its name in a dialog over the chat until the press has gone somewhere`, () => {
        for (const run of [runOf({ pressed: false }), runOf({ pressed: true })]) {
            expect(newSandboxDialogShown(asked, run)).toBe(true);
            expect(newSandboxPageShown(asked, run)).toBe(false);
        }
        // Not up yet: nothing to draw, rather than a dialog with no run behind it.
        expect(newSandboxDialogShown(asked, undefined)).toBe(false);
    });

    it(`puts up no tile before Create, nor while the dialog still holds the press`, () => {
        expect(newSandboxTileShown(chat, runOf({ pressed: false }))).toBe(false);
        expect(newSandboxTileShown(asked, runOf({ pressed: true }))).toBe(false);
    });

    it(`once started, leaves the chat to the reader with the tile on the rail, and shows the run when asked`, () => {
        const started = runOf({ pressed: true, started: `here` });
        expect(newSandboxTileShown(chat, started)).toBe(true);
        expect(newSandboxDialogShown(chat, started)).toBe(false);
        expect(newSandboxPageShown(chat, started)).toBe(false);
        expect(newSandboxPageShown(asked, started)).toBe(true);
        expect(newSandboxTileShown(asked, started)).toBe(true);
    });

    it(`keeps the tile for a press refused after the reader left, and shows the dialog again when it is pressed`, () => {
        // A machine of ours that would not start puts the run back before anything started.
        const refused = runOf({ pressed: true });
        expect(newSandboxTileShown(chat, refused)).toBe(true);
        expect(newSandboxDialogShown(asked, refused)).toBe(true);
    });
});

// A setup left unfinished, finished on Home: no dialog, its page and its tile from the press on.
describe(`finishing a setup left unfinished on Home`, () => {
    const finish = { name: `home`, query: finishOnHome(`row1`).query };

    it(`is asked by Home's address naming the row, beside the new sandbox's ask`, () => {
        expect(finishOnHome(`row1`)).toEqual({ path: `/home`, query: { add: `sandbox`, finish: `row1` } });
        expect(finishAskedBy(finish)).toBe(`row1`);
        expect(finishAskedBy({ name: `home`, query: { add: `sandbox` } })).toBeUndefined();
        expect(finishAskedBy({ name: `home`, query: { finish: `row1` } })).toBeUndefined();
        expect(finishAskedBy({ name: `home`, query: { add: `sandbox`, finish: `` } })).toBeUndefined();
    });

    it(`names a machine of ours, and its tier, only where the address does`, () => {
        expect(machineAskedBy({ name: `home`, query: { add: `sandbox`, machine: `hosted` } })).toBe(`hosted`);
        expect(machineAskedBy({ name: `home`, query: { add: `sandbox`, machine: `mine` } })).toBeUndefined();
        expect(tierAskedBy({ name: `home`, query: { tier: `standard` } })).toBe(`standard`);
        expect(tierAskedBy({ name: `home`, query: { tier: `gold` } })).toBeUndefined();
    });

    it(`shows its page and never the dialog, before its code is minted and after it was refused`, () => {
        for (const run of [runOf({ pressed: false }), runOf({ pressed: true, resumed: true })]) {
            expect(newSandboxDialogShown(finish, run)).toBe(false);
            expect(newSandboxPageShown(finish, run)).toBe(true);
        }
        // Gone back to from its tile, the address no longer names the row: still its page, still no form.
        const asked = { name: `home`, query: { add: `sandbox` } };
        expect(newSandboxDialogShown(asked, runOf({ pressed: true, resumed: true }))).toBe(false);
        expect(newSandboxPageShown(asked, runOf({ pressed: true, resumed: true }))).toBe(true);
        expect(newSandboxTileShown({ name: `home`, query: {} }, runOf({ pressed: true, resumed: true }))).toBe(true);
    });
});

describe(`where the new sandbox stands`, () => {
    it(`is a draft until Create, whatever else is said`, () => {
        expect(newSandboxPhase(facts({ pressed: false, refused: true }))).toBe(`draft`);
    });

    it(`runs from the press, through the app's install and this PC's own setup coming first`, () => {
        expect(newSandboxPhase(facts({ started: undefined }))).toBe(`running`);
        expect(newSandboxPhase(facts({ report: { state: `running`, percent: 40 } }))).toBe(`running`);
        expect(newSandboxPhase(facts({ report: { state: `waiting`, percent: 0, waitingFor: `pcSetup` } }))).toBe(`running`);
    });

    it(`asks when the app waits on the reader: a consent, a restart, a sign-out`, () => {
        for (const waitingFor of [`consent`, `restart`, `signOut`] as const) {
            expect(newSandboxPhase(facts({ report: { state: `waiting`, percent: 30, waitingFor } }))).toBe(`asking`);
        }
    });

    it(`has failed on a refusal, a failed machine run, a machine of ours that could not start, or an app run that stopped`, () => {
        expect(newSandboxPhase(facts({ started: undefined, refused: true }))).toBe(`failed`);
        expect(newSandboxPhase(facts({ started: `machine`, machineFailed: true }))).toBe(`failed`);
        expect(newSandboxPhase(facts({ started: `hosted`, hostedFailed: true }))).toBe(`failed`);
        expect(newSandboxPhase(facts({ report: { state: `failed`, percent: 60 } }))).toBe(`failed`);
        expect(newSandboxPhase(facts({ report: { state: `stopped`, percent: 60 } }))).toBe(`failed`);
    });

    it(`has failed when the machine running its command said what broke`, () => {
        expect(newSandboxPhase(facts({ started: `command`, commandFailed: true }))).toBe(`failed`);
        expect(newSandboxPhase(facts({ started: `command`, commandFailed: false }))).toBe(`running`);
        expect(newSandboxPhase(facts({ started: `attach` }))).toBe(`running`);
    });

    it(`reads a failure only off the run that was started`, () => {
        expect(newSandboxPhase(facts({ started: `hosted`, machineFailed: true }))).toBe(`running`);
        expect(newSandboxPhase(facts({ started: `machine`, report: { state: `failed`, percent: 0 } }))).toBe(`running`);
    });

    it(`is opening once it reported in, ahead of anything its run said before`, () => {
        expect(newSandboxPhase(facts({ opening: true, report: { state: `failed`, percent: 100 } }))).toBe(`opening`);
    });
});

describe(`the tile's line`, () => {
    it(`says the app's percent while it gives one, and only then`, () => {
        expect(newSandboxNote(`running`, facts({ report: { state: `running`, percent: 41.6 } }))).toBe(`Setting up · 42%`);
        expect(newSandboxNote(`running`, facts({ report: { state: `running`, percent: 0 } }))).toBe(`Setting up…`);
        expect(newSandboxNote(`running`, facts({ started: `hosted` }))).toBe(`Setting up…`);
        expect(newSandboxNote(`draft`, facts())).toBe(`Not created yet`);
        expect(newSandboxNote(`asking`, facts())).toBe(`Needs your answer`);
        expect(newSandboxNote(`failed`, facts({ started: undefined }))).toBe(`Could not be created`);
        expect(newSandboxNote(`failed`, facts({ started: `machine` }))).toBe(`Stopped before it was ready`);
    });
});

describe(`a sandbox made ready while its reader was elsewhere`, () => {
    it(`is marked until it is opened`, () => {
        markReady(`sbx-1`);
        markReady(`sbx-2`);
        seenReady(`sbx-1`);
        expect([...readySandboxes.value]).toEqual([`sbx-2`]);
        seenReady(`sbx-2`);
        expect(readySandboxes.value.size).toBe(0);
    });
});
