import type { PermissionMode } from "@intentic/sandbox-contract/schemas/agent";
import type { IconName } from "@intentic/ui";
import { modeMeta } from "../models/catalog";
import type { RunThroughState } from "../models/run-settings/useRunThrough";
import { t } from "@intentic/ui/i18n";

// One rule for the composer row vs overflow: a control at its default is a named row in the overflow
// menu; set to anything else, it becomes a chip on the row. A pure, testable table; model and effort
// aren't here since the row places them itself (effort draws nothing at all under Auto).

// When the message goes is not one of them: it is the send's own caret (ChatPane), beside the press it changes.
// `model` is the exception the plain words make: a developer's model rides the row as its own pill, and a reader who does
// not write code finds it here instead, one press away and out of the way.
export type ComposerControl = `mode` | `model` | `placement` | `persona` | `runThrough` | `voice` | `land`;

/**
 * Order the controls read in, row and menu alike, so muscle memory doesn't depend on which half they're on. Whether the
 * work lands by itself comes last, beside the Send it follows.
 */
export const CONTROL_ORDER: readonly ComposerControl[] = [`mode`, `model`, `placement`, `persona`, `runThrough`, `voice`, `land`];

export interface ComposerControlSituation {
    /** The posture the next turn starts in, or the running turn's if the agent has moved itself. */
    readonly mode: PermissionMode;
    /** This chat's own untouched posture (Auto for isolated, Plan for main-tree), not one hard-coded default. */
    readonly startingMode: PermissionMode;
    /**
     * Whether there is anywhere else to run: a runner is paired, another sandbox is reachable, or the chat is already
     * placed. A chat the board has seen keeps the row too, since placement is fixed then and the menu says where it runs.
     */
    readonly placementOffered: boolean;
    /** Running somewhere other than this sandbox: on one of its runners, or in another box. */
    readonly placed: boolean;
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
    /**
     * Plain words: a reader who does not write code is offered only what they can judge (how much it does before asking,
     * and which model answers), worded without the developer's terms. Absent reads as the developer's menu.
     */
    readonly plain?: boolean;
    /** A guest talks to the assistant it was handed, with its model and its posture: nothing here is theirs to change. */
    readonly guest?: boolean;
    /** The model the next turn runs on, as the pill would name it; the plain menu's model row says it. */
    readonly modelLabel?: string;
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

/** One yes or no per control: whether it is offered, set, or rides the row. */
export type ControlFlags = Readonly<Record<ComposerControl, boolean>>;

/** Whether the control exists for this chat at all. A control that isn't offered is in neither place. */
const offeredIn = (situation: ComposerControlSituation) => {
    if (situation.guest === true) {
        return { mode: false, model: false, placement: false, persona: false, runThrough: false, voice: false, land: false } satisfies ControlFlags;
    }
    // Plain words keep the two a non-coder can judge; the rest are a developer's tools and stay out of the menu.
    const developer = situation.plain !== true;
    return {
        mode: true,
        model: !developer,
        placement: developer && situation.placementOffered,
        persona: developer && situation.personaOffered,
        runThrough: developer,
        voice: developer && situation.voiceOffered,
        land: developer && situation.landOffered,
    } satisfies ControlFlags;
};

// Whether a control is doing something to the next send; the whole rule turns on this predicate. A
// running loop counts (its badge is also its stop), and so does a mode the agent moved itself into.
const setIn = (situation: ComposerControlSituation): Record<ComposerControl, boolean> => ({
    mode: situation.mode !== situation.startingMode,
    // Never a chip: the developer's pill is drawn by the row itself, and the plain menu keeps it whatever it is set to.
    model: false,
    placement: situation.placed,
    persona: situation.persona !== undefined,
    runThrough: situation.runThrough !== `idle`,
    voice: situation.voiceAgent,
    land: situation.landOwn,
});

/** Controls that ride the row as chips: offered and set to something other than default. */
export const ridesRow = (situation: ComposerControlSituation): Record<ComposerControl, boolean> => {
    const offered = offeredIn(situation);
    const set = setIn(situation);
    return {
        mode: offered.mode && set.mode,
        model: false,
        placement: offered.placement && set.placement,
        persona: offered.persona && set.persona,
        runThrough: offered.runThrough && set.runThrough,
        voice: offered.voice && set.voice,
        land: offered.land && set.land,
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
                label: situation.plain === true ? t(`chat.composerMore.plain.mode`) : t(`chat.words.agentMode`),
                value: meta.label,
                description: situation.plain === true ? t(`chat.composerMore.plain.modeNote`) : t(`chat.composerMore.howMuchMayDo`),
            };
        }
        case `model`:
            return {
                key: control,
                icon: `sparkles`,
                label: t(`chat.composerMore.plain.model`),
                value: situation.modelLabel ?? ``,
                description: t(`chat.composerMore.plain.modelNote`),
            };
        // Always this sandbox: a chat placed elsewhere has left the menu for a chip that names where it went.
        case `placement`:
            return {
                key: control,
                icon: `desktop`,
                label: t(`chat.words.whereRuns`),
                value: t(`shared.thisSandbox`),
                description: t(`chat.composerMore.whereRunsNote`),
            };
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
    }
};

/** Every offered control at its default, in the row's own order. */
export const overflowRows = (situation: ComposerControlSituation): ComposerMoreRow[] => {
    const offered = offeredIn(situation);
    const set = setIn(situation);
    return CONTROL_ORDER.filter((control) => offered[control] && !set[control]).map((control) => rowFor(control, situation));
};
