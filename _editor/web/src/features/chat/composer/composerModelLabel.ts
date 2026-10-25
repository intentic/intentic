import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { loopLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { t } from "@intentic/ui/i18n";
import { modelLabelFor } from "../../../models/providers/providerCatalog";
import { offeredLoops, selectedLoop } from "../../../models/providers/offeredLoops";
import { accessKnown, providerReadyOn } from "../../../models/providers/access";
import { turnDefaults } from "../../../models/conversations/run/turnDefaults";

// What a composer's model control reads as: one rule for the pill's own face and for the accessible name the pane
// writes beside it, which must not drift.

/** The turn settings the control speaks for; a plain snapshot, so the rule is testable without a conversation. */
export interface ComposerModelChoice {
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    readonly model: string;
    readonly auto: boolean;
}

export interface ComposerModelReading {
    /** The words on the control. */
    readonly label: string;
    /** Nothing here could answer: the control states that, quietly, rather than naming what will run. */
    readonly unset: boolean;
    /** It names a model somebody picked that is not connected here yet: drawn with a lock, as the list draws it. */
    readonly locked?: true;
}

export const composerModelReading = (chat: ComposerModelChoice): ComposerModelReading => {
    // Nothing here could answer. The pill says so in words, not as a press of its own (2026-10-25): it used to read
    // "Choose a model" beside a notice saying the same and a Send that opened the same list, and the one way on is the
    // notice's (ChatAccountPanel.vue). A model somebody picked is still named, with a lock, so a pick from the list visibly
    // takes; the app's own floor is not, since nobody chose that vendor. Held until `accessKnown`: a read that hasn't
    // answered cannot claim nothing is connected, and claiming it for one frame is the flicker this exists to avoid.
    if (accessKnown.value && !providerReadyOn(chat.provider, chat.harness)) {
        const picked = !chat.auto && turnDefaults.provider.value === chat.provider;
        return picked ? { label: modelLabelFor(chat.provider, chat.model), unset: true, locked: true } : { label: t(`chat.composerModelPill.noModel`), unset: true };
    }
    // On Auto the control says Auto, not the model underneath: that model is only the fallback if the reading never
    // lands, and naming it would read as though pressing the Auto row had done nothing.
    return { label: chat.auto ? t(`chat.words.autoLabel`) : [modelLabelFor(chat.provider, chat.model), ...loopWord(chat)].join(` · `), unset: false };
};

/** The reading as a screen reader is told it: a model named with its lock is said with it, since no glyph reaches one. */
export const composerModelName = (reading: ComposerModelReading): string =>
    reading.locked === true ? t(`chat.composerModelPill.lockedAria`, { model: reading.label }) : reading.label;

// The loop, named only where it isn't the provider's default: the same model through another loop is another run.
const loopWord = (chat: ComposerModelChoice): readonly string[] => {
    const offered = offeredLoops(chat.provider);
    const loop = selectedLoop(offered, chat.harness);
    return loop === offered[0] ? [] : [loopLabel(chat.provider, loop)];
};

/** A reply still running on the model it was sent with, while the pill already names the one picked for the next. */
export interface RunningTurn {
    readonly streaming: boolean;
    /** The model the running turn was sent under (the selection's `sentModel`); undefined before any was sent. */
    readonly sentModel: string | undefined;
}

// A model picked mid-turn applies from the next message: the reply in flight keeps the model it was sent under. Named
// here so the pill can say both, rather than read as though the switch had reached the reply already. Undefined when
// nothing is running, or the pick is still the model the reply runs on.
export const stillRunningOn = (chat: ComposerModelChoice, turn: RunningTurn): string | undefined =>
    turn.streaming && !chat.auto && turn.sentModel !== undefined && turn.sentModel !== `` && turn.sentModel !== chat.model
        ? modelLabelFor(chat.provider, turn.sentModel)
        : undefined;
