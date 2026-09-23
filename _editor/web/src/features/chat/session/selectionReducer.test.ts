import { describe, expect, it } from "bun:test";
import { AUTO_PROVIDER } from "../models/modelPickerState";
import type { SessionRef } from "../run/turnRequest";
import { type PickWorld, reduceSelection, type Selection, UNPICKED } from "./selectionReducer";

// Pins every pick as a value in and a value out: what each one does to the selection, what it asks of the world, and
// which it refuses, against a world that is only the facts a pick reads.

const WORLD: PickWorld = {
    streaming: false,
    generating: false,
    session: undefined,
    local: true,
    rememberedAccount: (provider) => `${provider}-account`,
    rememberedModel: (provider) => `${provider}-model`,
    defaults: () => ({ provider: `claude`, picked: undefined, harness: `native`, effort: `high`, thinking: true, auto: false }),
};
const LIVE: PickWorld = { ...WORLD, streaming: true, generating: true };
// A turn parked on a card: live, and not generating.
const PARKED: PickWorld = { ...WORLD, streaming: true };

const SEEDED: Selection = reduceSelection(UNPICKED, { kind: `seed` }, WORLD).selection;
// A chat that has sent a turn on Claude's remembered model.
const SENT: Selection = { ...SEEDED, sentModel: `claude-model` };
const CLAUDE_SESSION: SessionRef = { id: `s-1`, provider: `claude`, account: `claude-account`, harness: `native` };

describe(`seeding`, () => {
    it(`starts a chat on this browser's defaults, resolved against what this sandbox can run`, () => {
        expect(SEEDED).toEqual({
            ...UNPICKED,
            provider: `claude`,
            harness: `native`,
            account: `claude-account`,
            model: `claude-model`,
            effortPick: `high`,
            thinking: true,
            auto: false,
            displacedModel: undefined,
            movedFrom: undefined,
        });
    });

    it(`is born owing the pick back when the reader's last provider could not run here`, () => {
        const world: PickWorld = { ...WORLD, defaults: () => ({ ...WORLD.defaults(), picked: `codex` }) };

        expect(reduceSelection(UNPICKED, { kind: `seed` }, world).selection.movedFrom).toEqual({ provider: `codex`, value: `codex-model` });
    });
});

describe(`the provider`, () => {
    it(`switches on the reader's pick, re-scoping to the new provider and cutting the segment`, () => {
        expect(reduceSelection(SENT, { kind: `selectProvider`, provider: `codex` }, WORLD)).toEqual({
            selection: { ...SENT, provider: `codex`, account: `codex-account`, model: `codex-model`, sentModel: undefined },
            effects: { kept: true, remember: { provider: `codex`, value: `codex-model` }, segmentCut: true, divider: `refresh` },
        });
    });

    it(`comes back to the held session's own account when switched back to its runtime`, () => {
        const away = { ...SEEDED, provider: `codex` as const, account: `codex-account`, model: `codex-model` };
        const world = { ...WORLD, session: { ...CLAUDE_SESSION, account: `the-session-account` } };

        expect(reduceSelection(away, { kind: `selectProvider`, provider: `claude` }, world).selection.account).toBe(`the-session-account`);
    });

    it(`refuses a switch mid-turn and a switch to where it already is, changing nothing`, () => {
        expect(reduceSelection(SEEDED, { kind: `selectProvider`, provider: `codex` }, LIVE)).toEqual({ selection: SEEDED, effects: {} });
        expect(reduceSelection(SEEDED, { kind: `selectProvider`, provider: `claude` }, WORLD)).toEqual({ selection: SEEDED, effects: {} });
    });

    it(`owes the app's own move back, once, and remembers nothing`, () => {
        const moved = reduceSelection(SEEDED, { kind: `repointProvider`, provider: `codex` }, WORLD);
        expect(moved).toEqual({
            selection: {
                ...SEEDED,
                provider: `codex`,
                account: `codex-account`,
                model: `codex-model`,
                movedFrom: { provider: `claude`, value: `claude-model` },
            },
            effects: { segmentCut: true, divider: `refresh` },
        });

        // A second move keeps the first debt: the reader is owed what they had, not a stop on the way.
        const again = reduceSelection(moved.selection, { kind: `repointProvider`, provider: `grok` }, WORLD).selection;
        expect(again.movedFrom).toEqual({ provider: `claude`, value: `claude-model` });
    });

    it(`gives the moved pick back, model and all, but not mid-turn and not when nothing is owed`, () => {
        const moved = {
            ...SEEDED,
            provider: `codex` as const,
            account: `codex-account`,
            model: `codex-model`,
            movedFrom: { provider: `claude` as const, value: `opus` },
        };

        expect(reduceSelection(moved, { kind: `restoreProvider` }, WORLD)).toEqual({
            selection: { ...moved, provider: `claude`, account: `claude-account`, model: `opus`, movedFrom: undefined, sentModel: undefined },
            effects: { segmentCut: true, divider: `refresh` },
        });
        expect(reduceSelection(moved, { kind: `restoreProvider` }, LIVE).selection).toBe(moved);
        expect(reduceSelection(SEEDED, { kind: `restoreProvider` }, WORLD).selection).toBe(SEEDED);
    });
});

describe(`the model`, () => {
    it(`takes the reader's pick, ends both debts and Auto, and is remembered`, () => {
        const owed = { ...SENT, auto: true, displacedModel: `sonnet`, movedFrom: { provider: `codex` as const, value: `codex-model` } };

        expect(reduceSelection(owed, { kind: `selectModel`, pick: { provider: `claude`, value: `haiku` } }, WORLD)).toEqual({
            selection: { ...owed, auto: false, model: `haiku`, displacedModel: undefined, movedFrom: undefined },
            effects: { kept: true, remember: { provider: `claude`, value: `haiku` }, divider: `refresh` },
        });
    });

    it(`takes another provider's model as that provider's switch, and refuses it mid-turn where its own is fine`, () => {
        expect(reduceSelection(SENT, { kind: `selectModel`, pick: { provider: `codex`, value: `gpt-5` } }, WORLD).selection).toEqual({
            ...SENT,
            provider: `codex`,
            account: `codex-account`,
            model: `gpt-5`,
            sentModel: undefined,
        });
        expect(reduceSelection(SENT, { kind: `selectModel`, pick: { provider: `codex`, value: `gpt-5` } }, LIVE).selection).toBe(SENT);
        expect(reduceSelection(SENT, { kind: `selectModel`, pick: { provider: `claude`, value: `haiku` } }, LIVE).selection.model).toBe(`haiku`);
    });

    it(`arms Auto for the Auto row, leaving provider and model to run on if the reading never lands`, () => {
        expect(reduceSelection(SEEDED, { kind: `selectModel`, pick: { provider: AUTO_PROVIDER, value: `` } }, WORLD)).toEqual({
            selection: { ...SEEDED, auto: true },
            effects: { defaults: { auto: true } },
        });
    });

    it(`wears a card's model and settings as the card's choice: nothing remembered, nothing owed`, () => {
        const pin = { provider: `claude` as const, model: `haiku`, effort: `low`, thinking: false, harness: `claude-code` as const };

        expect(reduceSelection({ ...SEEDED, auto: true, displacedModel: `sonnet` }, { kind: `wearModel`, pin }, WORLD)).toEqual({
            selection: {
                ...SEEDED,
                model: `haiku`,
                effortPick: `low`,
                thinking: false,
                harness: `claude-code`,
                auto: false,
                displacedModel: undefined,
            },
            effects: { kept: true, divider: `refresh` },
        });
        expect(reduceSelection(SEEDED, { kind: `wearModel`, pin }, LIVE).selection).toBe(SEEDED);
    });

    it(`owes back the first model a thin catalog moved it off, and nothing for an empty one`, () => {
        const displaced = reduceSelection(SEEDED, { kind: `displaceModel`, model: `sonnet` }, WORLD);
        expect(displaced).toEqual({ selection: { ...SEEDED, model: `sonnet`, displacedModel: `claude-model` }, effects: { divider: `refresh` } });
        expect(reduceSelection(displaced.selection, { kind: `displaceModel`, model: `haiku` }, WORLD).selection.displacedModel).toBe(`claude-model`);
        expect(reduceSelection({ ...SEEDED, model: `` }, { kind: `displaceModel`, model: `sonnet` }, WORLD).selection.displacedModel).toBeUndefined();

        expect(reduceSelection(displaced.selection, { kind: `restoreModel` }, WORLD)).toEqual({
            selection: { ...SEEDED, model: `claude-model`, displacedModel: undefined },
            effects: { divider: `refresh` },
        });
    });
});

describe(`the settings`, () => {
    it(`writes each setting through to the next new chat, except speed, which drops the last answer instead`, () => {
        expect(reduceSelection(SEEDED, { kind: `setEffort`, effort: `max` }, WORLD)).toEqual({
            selection: { ...SEEDED, effortPick: `max` },
            effects: { defaults: { effort: `max` } },
        });
        expect(reduceSelection(SEEDED, { kind: `setThinking`, thinking: false }, WORLD).effects).toEqual({ defaults: { thinking: false } });
        expect(reduceSelection(SEEDED, { kind: `setFast`, fast: true }, WORLD)).toEqual({
            selection: { ...SEEDED, fast: true },
            effects: { fastStale: true },
        });
        expect(reduceSelection(SEEDED, { kind: `setAuto`, auto: true }, LIVE).selection).toBe(SEEDED);
    });

    it(`takes an account while a card waits, owing the divider to the settle, and refuses one while the model writes`, () => {
        expect(reduceSelection(SEEDED, { kind: `selectAccount`, account: `second` }, PARKED)).toEqual({
            selection: { ...SEEDED, account: `second`, switchedMidTurn: true },
            effects: { kept: true, accountPick: { provider: `claude`, account: `second` }, divider: `refresh` },
        });
        expect(reduceSelection(SEEDED, { kind: `selectAccount`, account: `second` }, LIVE).selection).toBe(SEEDED);
    });

    it(`switches the harness as a segment cut, remembered, and not mid-turn`, () => {
        expect(reduceSelection(SENT, { kind: `selectHarness`, harness: `claude-code` }, WORLD)).toEqual({
            selection: { ...SENT, harness: `claude-code`, sentModel: undefined },
            effects: { kept: true, defaults: { harness: `claude-code` }, segmentCut: true, divider: `refresh` },
        });
        expect(reduceSelection(SENT, { kind: `selectHarness`, harness: `claude-code` }, LIVE).selection).toBe(SENT);
    });
});

describe(`the session`, () => {
    it(`moves the held session onto a reconnected credential, retracting the divider rather than drawing one`, () => {
        expect(reduceSelection(SEEDED, { kind: `rebindAccount`, account: `renewed` }, { ...WORLD, session: CLAUDE_SESSION })).toEqual({
            selection: { ...SEEDED, account: `renewed` },
            effects: { session: { ...CLAUDE_SESSION, account: `renewed` }, divider: `drop` },
        });
    });

    it(`binds the daemon's session, pinning its account only on an unpinned local chat of the same provider`, () => {
        const unpinned = { ...SEEDED, account: undefined };
        const bound = { ...CLAUDE_SESSION, account: `served` };

        expect(reduceSelection(unpinned, { kind: `bindSession`, session: bound }, WORLD)).toEqual({
            selection: { ...unpinned, account: `served` },
            effects: { session: bound },
        });
        expect(reduceSelection(unpinned, { kind: `bindSession`, session: bound }, { ...WORLD, local: false }).selection).toBe(unpinned);
        expect(reduceSelection(SEEDED, { kind: `bindSession`, session: bound }, WORLD).selection).toBe(SEEDED);
        expect(reduceSelection(unpinned, { kind: `bindSession`, session: { ...bound, provider: `codex` } }, WORLD).selection).toBe(unpinned);
    });

    it(`resumes a history session on Claude's remembered account and native loop, planning first`, () => {
        const away = { ...SENT, provider: `codex` as const, account: `codex-account`, model: `codex-model`, displacedModel: `gpt-4` };

        expect(reduceSelection(away, { kind: `resumeHistory`, sessionId: `s-9` }, WORLD)).toEqual({
            selection: {
                ...away,
                modePick: `plan`,
                provider: `claude`,
                harness: `native`,
                account: `claude-account`,
                model: `claude-model`,
                displacedModel: undefined,
                sentModel: undefined,
            },
            effects: { session: { id: `s-9`, provider: `claude`, account: `claude-account`, harness: `native` } },
        });
    });
});

describe(`what a fork and a restore write`, () => {
    it(`hands a fork the source's picks, not its debts, its Auto or its divider facts`, () => {
        const source: Selection = {
            ...SENT,
            provider: `codex`,
            harness: `claude-code`,
            account: `codex-account`,
            model: `gpt-5`,
            effortPick: `max`,
            thinking: false,
            fast: true,
            modePick: `plan`,
            auto: true,
            displacedModel: `gpt-4`,
            switchedMidTurn: true,
        };

        expect(reduceSelection(SEEDED, { kind: `adopt`, from: source }, WORLD).selection).toEqual({
            ...SEEDED,
            provider: `codex`,
            harness: `claude-code`,
            account: `codex-account`,
            model: `gpt-5`,
            effortPick: `max`,
            thinking: false,
            fast: true,
            modePick: `plan`,
        });
    });

    it(`writes picks outright with no rule and nothing asked of the world`, () => {
        expect(reduceSelection(SEEDED, { kind: `set`, picks: { actsAs: `maya`, account: `second` } }, LIVE)).toEqual({
            selection: { ...SEEDED, actsAs: `maya`, account: `second` },
            effects: {},
        });
    });
});

describe(`a turn's own moments`, () => {
    it(`measures the next swap from the model a turn went out on, freezing the divider into the record`, () => {
        expect(reduceSelection(SEEDED, { kind: `sent` }, WORLD)).toEqual({
            selection: { ...SEEDED, sentModel: `claude-model` },
            effects: { divider: `freeze` },
        });
        expect(reduceSelection(SEEDED, { kind: `rerun` }, WORLD)).toEqual({ selection: SEEDED, effects: { divider: `freeze` } });
    });

    it(`owes a settle the divider for a segment switched while it ran, once`, () => {
        const switched = { ...SEEDED, switchedMidTurn: true };

        expect(reduceSelection(switched, { kind: `settled` }, WORLD)).toEqual({ selection: SEEDED, effects: { divider: { settle: true } } });
        expect(reduceSelection(SEEDED, { kind: `settled` }, WORLD)).toEqual({ selection: SEEDED, effects: { divider: { settle: false } } });
    });

    it(`spends Auto's mark on the one turn that takes its settings`, () => {
        expect(reduceSelection({ ...SEEDED, autoPicked: true }, { kind: `settingsTaken` }, WORLD).selection).toEqual(SEEDED);
        expect(reduceSelection(SEEDED, { kind: `settingsTaken` }, WORLD).selection).toBe(SEEDED);
    });
});
