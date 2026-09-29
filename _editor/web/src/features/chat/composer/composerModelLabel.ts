import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { modelLabelFor } from "../accounts/providerCatalog";
import { accessKnown, providerReadyOn } from "../session/access";

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
    /** Nothing here could answer: the control is a call to action, not a statement about what will run. */
    readonly unset: boolean;
}

export const composerModelReading = (chat: ComposerModelChoice): ComposerModelReading => {
    // A model id on the pill would contradict the line above the composer saying there is nothing to send with, and
    // the only use for the control there is to be pressed. Held until `accessKnown`: a read that hasn't answered
    // cannot claim nothing is connected, and claiming it for one frame is the flicker this exists to avoid.
    if (accessKnown.value && !providerReadyOn(chat.provider, chat.harness)) {
        return { label: t(`chat.composerModelPill.chooseModel`), unset: true };
    }
    // On Auto the control says Auto, not the model underneath: that model is only the fallback if the reading never
    // lands, and naming it would read as though pressing the Auto row had done nothing.
    return { label: chat.auto ? t(`chat.words.autoLabel`) : modelLabelFor(chat.provider, chat.model), unset: false };
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
