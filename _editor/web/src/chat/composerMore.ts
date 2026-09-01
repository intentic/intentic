import type { PermissionMode } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { modeMeta } from "../composables/chat/catalog";
import type { RunThroughState } from "../composables/chat/useRunThrough";

/* WHICH COMPOSER CONTROLS RIDE THE ROW, AND WHICH SIT BEHIND THE OVERFLOW.
 *
 * The composer's control row used to be a flat list of every feature that had ever wanted a slot in it: model,
 * effort, mode, placement, persona, run-through, agent voice, mic, send. Nine peers at one weight, five of them
 * bare glyphs that said nothing until hovered, which on a touch device is never. It rendered the FEATURE LIST,
 * and it grew by one glyph every time the app learned to do something else, so the row's width was a function of
 * the roadmap rather than of the chat.
 *
 * ONE RULE REPLACES THE LIST: nothing that changes what Send does is ever hidden, and nothing that isn't
 * changing it gets a permanent slot. A control at its default sits in the overflow as a NAMED row carrying its
 * current value; the moment it is set to anything else it leaves the menu and rides the row as a chip wearing
 * its own word. So the row says what is unusual about this chat, and the menu says what is ordinary about it,
 * and neither has to be hovered to be read.
 *
 * This is not a new idea in the composer, only a generalised one: the tier chip already appears only when there
 * is a cheaper rung to name, and the run-through badge already goes from a bare glyph to a named one when it is
 * armed. Both were the same rule, discovered twice and applied to one control each.
 *
 * NOTHING IS HIDDEN IN THE SENSE THAT WORD USUALLY MEANS. A menu row reading "Agent mode · Auto" with a sentence
 * under it is strictly more discoverable than a mute glyph whose only explanation was a desktop-only tooltip:
 * the harness stays fully exposed, it just stops shouting. Which is also why the overflow's rows carry a value
 * and a description rather than a label alone.
 *
 * A pure table, deliberately, so the whole rule can be read in one place and tested without a chat on screen:
 * the same reason composerIntent.ts is one. Placement, model and effort are NOT in here. They are the three the
 * row keeps unconditionally, and a control the row always shows has no rule to state. */

export type ComposerControl = `mode` | `persona` | `runThrough` | `voice`;

/** The order the controls read in, in the row and in the menu alike: muscle memory shouldn't depend on which
 *  half of the rule a control is currently on. */
export const CONTROL_ORDER: readonly ComposerControl[] = [`mode`, `persona`, `runThrough`, `voice`];

export interface ComposerControlSituation {
    /** The posture the next turn starts in, or the RUNNING turn's if the agent has moved itself. */
    readonly mode: PermissionMode;
    /** The posture this chat would start in untouched (turnDefaults.startingMode): its normal, not a constant.
     *  An isolated chat's normal is Auto and a main-tree chat's is Plan, so "differs from default" cannot be a
     *  comparison against one hard-coded mode without calling one of the two chats permanently unusual. */
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
    readonly description: string;
}

/** Whether the control exists for this chat at all. A control that isn't offered is in neither place. */
const offeredIn = (situation: ComposerControlSituation): Record<ComposerControl, boolean> => ({
    mode: true,
    persona: situation.personaOffered,
    runThrough: true,
    voice: situation.voiceOffered,
});

/* IS THIS CONTROL DOING SOMETHING TO THE NEXT SEND. The whole rule turns on this one predicate, so it is worth
 * being exact about each: a running loop counts (its badge is also its stop, and burying a stop in a menu would
 * leave a loop spending with no way out but the fleet board), and a mode the AGENT moved itself into counts too,
 * because the composer must not go on describing a posture the turn has left. */
const setIn = (situation: ComposerControlSituation): Record<ComposerControl, boolean> => ({
    mode: situation.mode !== situation.startingMode,
    persona: situation.persona !== undefined,
    runThrough: situation.runThrough !== `idle`,
    voice: situation.voiceAgent,
});

/** Which controls ride the row as chips: the ones that are offered AND set to something other than their
 *  default. Every other offered control is a row in {@link overflowRows}; the two never overlap, so there is
 *  exactly one place to press for any one control at any one time. */
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
            // The mode's own meta, read off the live value rather than off the default: they are equal wherever
            // this is reached, and reading the live one keeps the row honest if that ever stops being true.
            const meta = modeMeta(situation.mode);
            return { key: control, icon: meta.icon, label: `Agent mode`, value: meta.label, description: meta.description };
        }
        case `persona`:
            return {
                key: control,
                icon: `users`,
                label: `Acts as`,
                value: `Anyone`,
                description: `Speak through one persona's accounts, and only that person's.`,
            };
        case `runThrough`:
            return {
                key: control,
                icon: `fork`,
                label: `Run through`,
                value: `Just this chat`,
                description: `Repeat this message until a goal is met, or hand it to a workflow.`,
            };
        case `voice`:
            return {
                key: control,
                icon: `robot`,
                label: `Write as agent`,
                value: `Off`,
                description: `Place your words into the transcript in the agent's voice, with no reply.`,
            };
    }
};

/** What the overflow holds: every offered control sitting at its default, in the row's own order. Empty is a
 *  real answer — a chat with all four set has nothing left to collapse, and the composer drops the button. */
export const overflowRows = (situation: ComposerControlSituation): ComposerMoreRow[] => {
    const offered = offeredIn(situation);
    const set = setIn(situation);
    return CONTROL_ORDER.filter((control) => offered[control] && !set[control]).map((control) => rowFor(control, situation));
};
