import type { AgentHarness, AgentProvider, ModelPin, PermissionMode } from "@intentic/sandbox-contract";
import { isAutoPick } from "../models/modelPickerState";
import { startingMode, type TurnPick } from "../run/turnDefaults";
import type { SessionRef } from "../run/turnRequest";

// What a conversation's next turn runs on, as one value and one pure function: `reduceSelection` takes the selection, a
// pick and the facts the pick reads, and returns the next selection with what it asks of the world (PickEffects),
// which ComposerSelection carries out. Nothing here reads a module, a ref or a clock.

// Every pick the next turn runs under, plus the two facts a "switched" divider is measured by.
export interface Selection {
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    // Where the conversation runs as the daemon reports it (bindSession), or, before it has run, the person's pick.
    // Undefined is auto: never a seeded guess, so a fresh chat's first turn is placed by the daemon's serviceability
    // pick. A pick on a conversation the daemon holds moves it there (`switchAccount`), never by riding a later turn.
    readonly account: string | undefined;
    readonly model: string;
    // Provider/model the app moved this chat FROM when it couldn't run there; cleared by restoreProvider or a pick.
    readonly movedFrom: TurnPick | undefined;
    // Model the app moved this chat OFF because its provider stopped offering that id, owed back when the catalog lists
    // it again (restoreModel). Same provider, so it is not a `movedFrom`; cleared by any pick of the user's own.
    readonly displacedModel: string | undefined;
    readonly thinking: boolean;
    // Fast speed for this chat's turns; never seeded from the defaults, since fast mode costs more.
    readonly fast: boolean;
    // On Auto with the model still to be chosen: a model reads the opening message and wears the answer (chatRoute.ts).
    // `provider`/`model` keep their remembered values underneath, which is what runs if the reading never lands.
    readonly auto: boolean;
    // The next turn's model was chosen by Auto's reading; describes ONE turn, spent when that turn takes its settings.
    readonly autoPicked: boolean;
    // Persona this chat acts as externally, or undefined for the ordinary chat with every account.
    readonly actsAs: string | undefined;
    // The project the conversation was started under (app/projectScope.ts); sent with the first turn and latched there.
    readonly startIn: string | undefined;
    // Reasoning effort asked for; not always runnable, since the effort scale belongs to the model.
    readonly effortPick: string;
    // The user's permission posture, the composer's own pick.
    readonly modePick: PermissionMode;
    // Model the last SENT turn went out under, not the reported one: what a model swap is measured against.
    readonly sentModel: string | undefined;
    // A switch made while parked on a card, owed a divider it could not get then; the settle draws it.
    readonly switchedMidTurn: boolean;
}

// The picks a caller may set outright; the two divider facts move only with the turns that decide them.
export type Picks = Omit<Selection, "sentModel" | "switchedMidTurn">;

// What an untouched chat is seeded from: this browser's defaults for the next new chat.
export interface SeedDefaults {
    // The provider the defaults resolve to on this sandbox, and the one the reader last picked, when that differs.
    readonly provider: AgentProvider;
    readonly picked: AgentProvider | undefined;
    readonly harness: AgentHarness;
    readonly effort: string;
    readonly thinking: boolean;
    readonly auto: boolean;
}

// What a pick reads of the world, handed in so that the reducer reads nothing else.
export interface PickWorld {
    // Most picks wait out a live turn; an account waits only while the model is generating (not parked on a card).
    readonly streaming: boolean;
    readonly generating: boolean;
    // The session the daemon last reported for this chat, and whether this chat runs in this browser's own box.
    readonly session: SessionRef | undefined;
    readonly local: boolean;
    // Where a pick of a provider lands in this browser, and what a fresh chat starts on. No account: a fresh chat's is
    // the daemon's to pick (auto), never this browser's memory of an earlier one.
    readonly rememberedModel: (provider: AgentProvider) => string;
    readonly defaults: () => SeedDefaults;
}

export type PickAction =
    | { readonly kind: `seed` }
    // The reader's own provider switch, remembered for the next new chat; mid-chat it lands at the next send.
    | { readonly kind: `selectProvider`; readonly provider: AgentProvider }
    // The same switch made by the app, owing the pick it moved the chat off back to this chat alone.
    | { readonly kind: `repointProvider`; readonly provider: AgentProvider }
    // Gives that pick back, now the provider it was moved off can serve it again.
    | { readonly kind: `restoreProvider` }
    // One picker row is provider + model; the harness is its own axis, so a model pick keeps it.
    | { readonly kind: `selectModel`; readonly pick: TurnPick }
    // A persona's model as the CARD's choice, not the user's: nothing is remembered, and nothing owed back later.
    | { readonly kind: `wearModel`; readonly pin: ModelPin }
    // The app's own swap off a model the provider no longer lists, owing it back (restoreModel).
    | { readonly kind: `displaceModel`; readonly model: string }
    | { readonly kind: `restoreModel` }
    | { readonly kind: `setEffort`; readonly effort: string }
    | { readonly kind: `setThinking`; readonly thinking: boolean }
    | { readonly kind: `setFast`; readonly fast: boolean }
    | { readonly kind: `setAuto`; readonly auto: boolean }
    | { readonly kind: `selectAccount`; readonly account: string }
    | { readonly kind: `accountMoved`; readonly account: string }
    | { readonly kind: `selectHarness`; readonly harness: AgentHarness }
    // The session as the daemon has it, bound to this chat.
    | { readonly kind: `bindSession`; readonly session: SessionRef }
    // A fork's selection: the source's picks ride across, no session does.
    | { readonly kind: `adopt`; readonly from: Selection }
    // A past Claude session from the history menu, resumed on the default account from the main tree's posture.
    | { readonly kind: `resumeHistory`; readonly sessionId: string }
    // Picks written outright, with no rule of their own: a restored tab, a route's or a persona's answer.
    | { readonly kind: `set`; readonly picks: Partial<Picks> }
    // A turn went out, a held turn re-ran, a turn settled, a turn took its settings.
    | { readonly kind: `sent` }
    | { readonly kind: `rerun` }
    | { readonly kind: `settled` }
    | { readonly kind: `settingsTaken` };

// What a pick asks of the world beyond the selection, carried out by ComposerSelection.
export interface PickEffects {
    // The reader acted on this chat, which takes it out of the peek slot.
    readonly kept?: true;
    // The next new chat's defaults: the provider/model pair, the settings a pick writes through, the account per provider.
    readonly remember?: TurnPick;
    readonly defaults?: { readonly effort?: string; readonly thinking?: boolean; readonly auto?: boolean; readonly harness?: AgentHarness };
    // Move the conversation the daemon holds to this account (switchAccount); a chat it does not hold yet takes the pick
    // on its first turn instead.
    readonly switchAccount?: string;
    // What the running segment reported (its model, its context meter) no longer describes the next turn.
    readonly segmentCut?: true;
    // The last speed answer described a turn run under the old fast pick.
    readonly fastStale?: true;
    // The session as the daemon last reported it, as this pick leaves it.
    readonly session?: SessionRef;
    // The one pending "switched" divider: follow the picks, stay in the record as it is, or be owed by a settle
    // (`settle` says whether a segment switch was made while the turn ran).
    readonly divider?: `refresh` | `freeze` | { readonly settle: boolean };
}

export interface PickOutcome {
    readonly selection: Selection;
    readonly effects: PickEffects;
}

// A chat before anything seeded it.
export const UNPICKED: Selection = {
    provider: `claude`,
    harness: `native`,
    account: undefined,
    model: ``,
    movedFrom: undefined,
    displacedModel: undefined,
    thinking: true,
    fast: false,
    auto: false,
    autoPicked: false,
    actsAs: undefined,
    startIn: undefined,
    effortPick: ``,
    modePick: startingMode(true),
    sentModel: undefined,
    switchedMidTurn: false,
};

const unchanged = (selection: Selection): PickOutcome => ({ selection, effects: {} });

// Points the selection at `next`, re-scoping what belonged to the provider being left; undefined when refused (a live
// turn, or already there). The owed model and the swap baseline were the old provider's, so neither survives.
const pointAt = (selection: Selection, next: AgentProvider, world: PickWorld): Selection | undefined => {
    if (world.streaming || next === selection.provider) {
        return undefined;
    }
    return {
        ...selection,
        provider: next,
        // Switching back to the session's own runtime shows its account again, the one the daemon runs it on. A pick
        // made on the provider being left names none of the next one's accounts: another provider starts on auto.
        account: next === world.session?.provider ? world.session.account : undefined,
        model: world.rememberedModel(next),
        displacedModel: undefined,
        sentModel: undefined,
    };
};

// Where a provider switch leaves the selection, and the cut and the divider it owes when it took.
const pointed = (selection: Selection, next: AgentProvider, world: PickWorld): { readonly selection: Selection; readonly effects: PickEffects } => {
    const moved = pointAt(selection, next, world);
    return moved === undefined ? { selection, effects: {} } : { selection: moved, effects: { segmentCut: true, divider: `refresh` } };
};

type Reducers = {
    readonly [K in PickAction["kind"]]: (selection: Selection, action: Extract<PickAction, { kind: K }>, world: PickWorld) => PickOutcome;
};

// Auto is a mode, not a route: arming it leaves provider and model as they were, so a chat whose reading never lands
// still has somewhere to run. Refused mid-stream: a reading taken now would name a model for a turn already running.
const setAuto = (selection: Selection, auto: boolean, world: PickWorld): PickOutcome =>
    world.streaming ? unchanged(selection) : { selection: { ...selection, auto }, effects: { defaults: { auto } } };

const REDUCERS: Reducers = {
    seed: (selection, _action, world) => {
        const defaults = world.defaults();
        const { provider, picked } = defaults;
        return {
            selection: {
                ...selection,
                provider,
                harness: defaults.harness,
                // Auto: the daemon places the first turn by serviceability.
                account: undefined,
                model: world.rememberedModel(provider),
                effortPick: defaults.effort,
                thinking: defaults.thinking,
                auto: defaults.auto,
                // A re-seeded draft starts over on today's picks; whatever a catalog owed the last one is gone with it.
                displacedModel: undefined,
                // Born displaced when the pick couldn't run here and something else was substituted.
                movedFrom: picked === undefined || picked === provider ? undefined : { provider: picked, value: world.rememberedModel(picked) },
            },
            effects: {},
        };
    },
    selectProvider: (selection, { provider }, world) => {
        const moved = pointAt(selection, provider, world);
        if (moved === undefined) {
            return unchanged(selection);
        }
        // A choice, so nothing is owed back: whatever the app had moved this chat from no longer applies.
        return {
            selection: { ...moved, movedFrom: undefined },
            effects: { kept: true, remember: { provider, value: moved.model }, segmentCut: true, divider: `refresh` },
        };
    },
    repointProvider: (selection, { provider }, world) => {
        const moved = pointAt(selection, provider, world);
        if (moved === undefined) {
            return unchanged(selection);
        }
        const from: TurnPick = { provider: selection.provider, value: selection.model };
        return { selection: { ...moved, movedFrom: selection.movedFrom ?? from }, effects: { segmentCut: true, divider: `refresh` } };
    },
    restoreProvider: (selection, _action, world) => {
        const from = selection.movedFrom;
        if (from === undefined || world.streaming) {
            return unchanged(selection);
        }
        const back = pointed(selection, from.provider, world);
        // The model it was displaced FROM, not the provider's remembered one: each displaced chat is owed its own back.
        return { selection: { ...back.selection, model: from.value, movedFrom: undefined }, effects: back.effects };
    },
    selectModel: (selection, { pick }, world) => {
        if (isAutoPick(pick)) {
            return setAuto(selection, true, world);
        }
        if (world.streaming && pick.provider !== selection.provider) {
            return unchanged(selection);
        }
        const moved = pointed(selection, pick.provider, world);
        return {
            // Naming a model answers the question Auto was armed to ask. A choice, so nothing is owed back either: both
            // debts go, since a same-provider pick skips the provider switch's own clearing.
            selection: { ...moved.selection, auto: false, model: pick.value, movedFrom: undefined, displacedModel: undefined },
            // A same-provider swap earns a divider too: it re-reads the whole conversation on a model never seen.
            effects: { ...moved.effects, kept: true, remember: pick, divider: `refresh` },
        };
    },
    wearModel: (selection, { pin }, world) => {
        if (world.streaming) {
            return unchanged(selection);
        }
        const moved = pointed(selection, pin.provider, world);
        return {
            selection: {
                ...moved.selection,
                // Named, whoever named it: a persona's card or Auto's own reading answers the question Auto asks.
                auto: false,
                model: pin.model,
                effortPick: pin.effort ?? moved.selection.effortPick,
                thinking: pin.thinking ?? moved.selection.thinking,
                harness: pin.harness ?? moved.selection.harness,
                movedFrom: undefined,
                displacedModel: undefined,
            },
            effects: { ...moved.effects, kept: true, divider: `refresh` },
        };
    },
    displaceModel: (selection, { model }) => {
        if (model === selection.model) {
            return unchanged(selection);
        }
        // An empty id is not a pick (a fresh chat before its catalog lands, an ACP row), so nothing is owed for it.
        const owed = selection.model === `` ? selection.displacedModel : (selection.displacedModel ?? selection.model);
        return { selection: { ...selection, displacedModel: owed, model }, effects: { divider: `refresh` } };
    },
    restoreModel: (selection) =>
        selection.displacedModel === undefined
            ? unchanged(selection)
            : { selection: { ...selection, model: selection.displacedModel, displacedModel: undefined }, effects: { divider: `refresh` } },
    // The PICK, not always the effort in force: the effort a turn runs at is this clamped to the model's scale.
    setEffort: (selection, { effort }) => ({ selection: { ...selection, effortPick: effort }, effects: { defaults: { effort } } }),
    // No clamp: turning thinking off invalidates a `max` pick, but the effort in force already reads thinking.
    setThinking: (selection, { thinking }) => ({ selection: { ...selection, thinking }, effects: { defaults: { thinking } } }),
    // Never a default (see `fast`); the last answer described a turn run under the old setting.
    setFast: (selection, { fast }) => ({ selection: { ...selection, fast }, effects: { fastStale: true } }),
    setAuto: (selection, { auto }, world) => setAuto(selection, auto, world),
    // Allowed while a card waits on the user: the parked turn keeps its credential, and the divider waits for its settle.
    // The daemon is asked to move the conversation (switchAccount); one that cannot yet takes it on the next turn.
    selectAccount: (selection, { account }, world) =>
        world.generating
            ? unchanged(selection)
            : {
                  selection: { ...selection, account, switchedMidTurn: selection.switchedMidTurn || world.streaming },
                  effects: { kept: true, switchAccount: account, divider: `refresh` },
              },
    // The daemon moved the conversation itself, at this window's press (a held turn continued elsewhere): the selection
    // follows, with the divider a switch owes, and nothing asked of the daemon again.
    accountMoved: (selection, { account }) => ({ selection: { ...selection, account }, effects: { divider: `refresh` } }),
    // Meaningful for codex/grok only. A retired session takes its prompt cache with it, as a provider switch does.
    selectHarness: (selection, { harness }, world) =>
        world.streaming || harness === selection.harness
            ? unchanged(selection)
            : {
                  selection: { ...selection, harness, sentModel: undefined },
                  effects: { kept: true, defaults: { harness }, segmentCut: true, divider: `refresh` },
              },
    // The daemon's word on where the conversation runs, shown: how a move the daemon made by itself (a limit move, a
    // turn moved off an account that can no longer serve) reaches the composer. It decides nothing: a turn names no
    // account the daemon already holds (accountIntent). A remote box's foreign id and another provider's session are
    // never taken, and a session naming no account says nothing about one.
    bindSession: (selection, { session }, world) =>
        world.local && session.provider === selection.provider && session.account !== undefined && session.account !== selection.account
            ? { selection: { ...selection, account: session.account }, effects: { session, divider: `refresh` } }
            : { selection, effects: { session } },
    // The PICKS, not what they currently clamp to: a fork inherits the user's choice, not one model's ceiling.
    adopt: (selection, { from }) => ({
        selection: {
            ...selection,
            provider: from.provider,
            harness: from.harness,
            account: from.account,
            model: from.model,
            effortPick: from.effortPick,
            thinking: from.thinking,
            fast: from.fast,
            modePick: from.modePick,
        },
        effects: {},
    }),
    // On auto: whichever account the daemon's serviceability pick lands on, which the session frame then names.
    resumeHistory: (selection, { sessionId }, world) => ({
        selection: {
            ...selection,
            // A turn on the tree the user is looking at plans before it touches anything.
            modePick: startingMode(false),
            provider: `claude`,
            harness: `native`,
            account: undefined,
            model: world.rememberedModel(`claude`),
            // A restored conversation is a fresh identity in this tab; it inherits no catalog's debt.
            displacedModel: undefined,
            // Whatever the session last ran on, this window never sent it, so no swap can claim a lost cache.
            sentModel: undefined,
        },
        effects: { session: { id: sessionId, provider: `claude`, account: undefined, harness: `native` } },
    }),
    set: (selection, { picks }) => ({ selection: { ...selection, ...picks }, effects: {} }),
    // The divider, if any, is frozen into the record by the segment cut, and this turn is what a swap is measured by.
    sent: (selection) => ({ selection: { ...selection, sentModel: selection.model }, effects: { divider: `freeze` } }),
    rerun: (selection) => ({ selection, effects: { divider: `freeze` } }),
    settled: (selection) => ({ selection: { ...selection, switchedMidTurn: false }, effects: { divider: { settle: selection.switchedMidTurn } } }),
    settingsTaken: (selection) => (selection.autoPicked ? { selection: { ...selection, autoPicked: false }, effects: {} } : unchanged(selection)),
};

// The table is keyed by the action's own kind, so the entry read always takes the action it is handed.
export const reduceSelection = (selection: Selection, action: PickAction, world: PickWorld): PickOutcome =>
    (REDUCERS[action.kind] as (selection: Selection, action: PickAction, world: PickWorld) => PickOutcome)(selection, action, world);
