import type { PermissionMode } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { modeMeta } from "../models/catalog";
import type { RunThroughState } from "../models/run-settings/useRunThrough";
import { t } from "@intentic/ui/i18n";

// One rule for the composer row vs overflow: a control at its default is a named row in the overflow
// menu; set to anything else, it becomes a chip on the row. A pure, testable table; placement, model
// and effort aren't here since the row places them itself (effort draws nothing at all under Auto).

export type ComposerControl = `mode` | `persona` | `runThrough` | `voice` | `land` | `later`;

/**
 * Order the controls read in, row and menu alike, so muscle memory doesn't depend on which half they're on. The two
 * about when the work moves come last, beside the Send they change: whether it lands by itself, and when it goes.
 */
export const CONTROL_ORDER: readonly ComposerControl[] = [`mode`, `persona`, `runThrough`, `voice`, `land`, `later`];

export interface ComposerControlSituation {
    /** The posture the next turn starts in, or the running turn's if the agent has moved itself. */
    readonly mode: PermissionMode;
    /** This chat's own untouched posture (Auto for isolated, Plan for main-tree), not one hard-coded default. */
    readonly startingMode: PermissionMode;
    readonly persona: string | undefined;
    readonly runThrough: RunThroughState;
    readonly voiceAgent: boolean;
    /** Personas belong to one daemon, so a chat living in another sandbox is offered none. */
    readonly personaOffered: boolean;
    /** Writing as the agent needs a transcript to place into: offered from this chat's first turn on. */
    readonly voiceOffered: boolean;
    /** Whether finished work lands by itself is this chat's to answer: a private copy here, and a reader who may land. */
    readonly landOffered: boolean;
    /** Whether it does, as this chat answers it now (its own answer, else the sandbox's). */
    readonly lands: boolean;
    /** Whether that answer is the chat's own rather than the sandbox's. */
    readonly landOwn: boolean;
    /** Booking a message for later needs a sandbox that holds one, and a send nothing else claims (a workflow, a loop). */
    readonly laterOffered: boolean;
    /** A time or an agent to wait for is picked for the next message. */
    readonly later: boolean;
}

export interface ComposerMoreRow {
    readonly key: ComposerControl;
    readonly icon: IconName;
    readonly label: string;
    /** What it is set to right now. Always the default, since a control set to anything else has left the menu. */
    readonly value: string;
    /** One line, and it has to stay one line: see {@link DESCRIPTION_LIMIT}. */
    readonly description: string;
}

// Kept under the ~45 characters that fit a w-80 panel at text-2xs, so descriptions stay glanceable.
export const DESCRIPTION_LIMIT = 40;

/** Whether the control exists for this chat at all. A control that isn't offered is in neither place. */
const offeredIn = (situation: ComposerControlSituation): Record<ComposerControl, boolean> => ({
    mode: true,
    persona: situation.personaOffered,
    runThrough: true,
    voice: situation.voiceOffered,
    land: situation.landOffered,
    later: situation.laterOffered,
});

// Whether a control is doing something to the next send; the whole rule turns on this predicate. A
// running loop counts (its badge is also its stop), and so does a mode the agent moved itself into.
const setIn = (situation: ComposerControlSituation): Record<ComposerControl, boolean> => ({
    mode: situation.mode !== situation.startingMode,
    persona: situation.persona !== undefined,
    runThrough: situation.runThrough !== `idle`,
    voice: situation.voiceAgent,
    land: situation.landOwn,
    later: situation.later,
});

/** Controls that ride the row as chips: offered and set to something other than default. */
export const ridesRow = (situation: ComposerControlSituation): Record<ComposerControl, boolean> => {
    const offered = offeredIn(situation);
    const set = setIn(situation);
    return {
        mode: offered.mode && set.mode,
        persona: offered.persona && set.persona,
        runThrough: offered.runThrough && set.runThrough,
        voice: offered.voice && set.voice,
        land: offered.land && set.land,
        later: offered.later && set.later,
    };
};

const rowFor = (control: ComposerControl, situation: ComposerControlSituation): ComposerMoreRow => {
    switch (control) {
        case `mode`: {
            // Reads the live mode, not MODE_META's description, which is written for the picker and wraps here.
            const meta = modeMeta(situation.mode);
            return {
                key: control,
                icon: meta.icon,
                label: t(`chat.words.agentMode`),
                value: meta.label,
                description: t(`chat.composerMore.howMuchMayDo`),
            };
        }
        case `persona`:
            return {
                key: control,
                icon: `users`,
                label: t(`chat.words.acts`),
                value: t(`chat.words.anyone`),
                description: t(`chat.composerMore.onePersonasAccountsOnly`),
            };
        case `runThrough`:
            return {
                key: control,
                icon: `fork`,
                label: t(`chat.composerMore.runThrough`),
                value: t(`chat.chatRunThroughMenu.justChat`),
                description: t(`chat.composerMore.loopRunWorkflow`),
            };
        case `voice`:
            return {
                key: control,
                icon: `robot`,
                label: t(`chat.composerMore.writeAgent`),
                value: t(`chat.composerMore.off`),
                description: t(`chat.composerMore.landsInTranscriptNo`),
            };
        // The press itself, as voice's is: it turns the answer the other way, and the pill it leaves turns it back.
        case `land`:
            return {
                key: control,
                icon: `download`,
                label: t(`chat.composerMore.landWhenDone`),
                value: situation.lands ? t(`chat.composerMore.on`) : t(`chat.composerMore.off`),
                description: situation.lands ? t(`chat.composerMore.holdOnBranchNote`) : t(`chat.composerMore.landWhenDoneNote`),
            };
        case `later`:
            return {
                key: control,
                icon: `clock`,
                label: t(`chat.composerMore.sendLater`),
                value: t(`chat.composerMore.sendLaterNow`),
                description: t(`chat.composerMore.sendLaterNote`),
            };
    }
};

/** Every offered control at its default, in the row's own order. */
export const overflowRows = (situation: ComposerControlSituation): ComposerMoreRow[] => {
    const offered = offeredIn(situation);
    const set = setIn(situation);
    return CONTROL_ORDER.filter((control) => offered[control] && !set[control]).map((control) => rowFor(control, situation));
};
