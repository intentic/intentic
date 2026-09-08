import type { PermissionMode } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { modeMeta } from "../models/catalog";
import type { RunThroughState } from "../models/useRunThrough";

// One rule for the composer row vs overflow: a control at its default is a named row in the overflow
// menu; set to anything else, it becomes a chip on the row. A pure, testable table; placement, model
// and effort aren't here since the row always shows them unconditionally.

export type ComposerControl = `mode` | `persona` | `runThrough` | `voice`;

/** Order the controls read in, row and menu alike, so muscle memory doesn't depend on which half they're on. */
export const CONTROL_ORDER: readonly ComposerControl[] = [`mode`, `persona`, `runThrough`, `voice`];

export interface ComposerControlSituation {
    /** The posture the next turn starts in, or the running turn's if the agent has moved itself. */
    readonly mode: PermissionMode;
    /** This chat's own untouched posture (Auto for isolated, Plan for main-tree), not one hard-coded default. */
    readonly startingMode: PermissionMode;
    readonly persona: string | undefined;
    readonly runThrough: RunThroughState;
    readonly voiceAgent: boolean;
    /** Personas are one daemon's cards, so a chat living in another sandbox is offered none. */
    readonly personaOffered: boolean;
    /** Writing as the agent needs a transcript to place into: offered from this chat's first turn on. */
    readonly voiceOffered: boolean;
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
});

// Whether a control is doing something to the next send; the whole rule turns on this predicate. A
// running loop counts (its badge is also its stop), and so does a mode the agent moved itself into.
const setIn = (situation: ComposerControlSituation): Record<ComposerControl, boolean> => ({
    mode: situation.mode !== situation.startingMode,
    persona: situation.persona !== undefined,
    runThrough: situation.runThrough !== `idle`,
    voice: situation.voiceAgent,
});

/**
 * Controls that ride the row as chips: offered and set to something other than default. Every other
 * offered control is a row in {@link overflowRows}; the two never overlap.
 */
export const ridesRow = (situation: ComposerControlSituation): Record<ComposerControl, boolean> => {
    const offered = offeredIn(situation);
    const set = setIn(situation);
    return {
        mode: offered.mode && set.mode,
        persona: offered.persona && set.persona,
        runThrough: offered.runThrough && set.runThrough,
        voice: offered.voice && set.voice,
    };
};

const rowFor = (control: ComposerControl, situation: ComposerControlSituation): ComposerMoreRow => {
    switch (control) {
        case `mode`: {
            // Reads the live mode, not MODE_META's description, which is written for the picker and wraps here.
            const meta = modeMeta(situation.mode);
            return { key: control, icon: meta.icon, label: `Agent mode`, value: meta.label, description: `How much it may do before asking.` };
        }
        case `persona`:
            return { key: control, icon: `users`, label: `Acts as`, value: `Anyone`, description: `One persona's accounts only.` };
        case `runThrough`:
            return { key: control, icon: `fork`, label: `Run through`, value: `Just this chat`, description: `Loop it, or run a workflow.` };
        case `voice`:
            return { key: control, icon: `robot`, label: `Write as agent`, value: `Off`, description: `Lands in the transcript, no reply.` };
    }
};

/**
 * Every offered control at its default, in the row's own order. Empty is real: with all four set, the
 * composer drops the overflow button entirely.
 */
export const overflowRows = (situation: ComposerControlSituation): ComposerMoreRow[] => {
    const offered = offeredIn(situation);
    const set = setIn(situation);
    return CONTROL_ORDER.filter((control) => offered[control] && !set[control]).map((control) => rowFor(control, situation));
};
