import { type InjectionKey, onBeforeUnmount, onMounted } from "vue";

// THE KIT'S CONTROLS, AS AN AGENT CAN READ AND WORK THEM. A picker that an agent drives through a page snapshot costs it
// a snapshot to find the trigger, a click to open it, another snapshot to find the row, and a click on that row, each
// answered with the page's whole accessibility tree. Registered here, the same picker is one entry in a list (its name,
// its value, its choices) and one call to change it, made through the component's own model, as a press would.
// Setting a theme, a language and a wallpaper on the Appearance page took 7 browser calls and 41 KB of snapshots by
// clicking, and 2 calls and 3.3 KB this way (2026-11-24); ui-sdk's agent bridge, the idea's source, measured 55-60%.
//
// Idle unless armed: the dev build arms it before the app mounts (web's main.ts) and reads it through its WebMCP tools
// (web's shell/agentControlTools.ts). Until then `useAgentControl` returns before hooking anything, so a production
// build pays one comparison per mounted control and keeps no record of any of them.

/** One choice a control offers. */
export interface ControlChoice {
    readonly value: string;
    readonly label: string;
    readonly disabled?: boolean;
}

/** What a control reports about itself: flat facts an agent reads, never a structure it has to walk. */
export type ControlStateValue = string | number | boolean | null;

/**
 * Something an agent may do to a control, by what it takes. The caller's JSON is parsed against `takes` at the tool's
 * door, so `run` gets the value it names; one that can't be done now throws, in words.
 */
export type ControlAction =
    | { readonly takes: `nothing`; readonly run: () => void }
    | { readonly takes: `flag`; readonly run: (on: boolean) => void }
    | { readonly takes: `choice`; readonly run: (choice: ControlChoice) => void };

/** A control's actions, by the name an agent calls each one by. */
export type ControlActions = Record<string, ControlAction>;

/** A control as a component registers it. Every member is read when asked, so the answer is what's on screen now. */
export interface AgentControl {
    /** What sort of control: `picker`, `segmented`, `dialog`, `disclosure`. */
    readonly kind: string;
    /** Where it is: its name is read from here when `label` gives none, and whether it is on screen. */
    readonly element: () => Element | null | undefined;
    /** Its name, where the component knows it better than the element's accessible name does (a dialog's title). */
    readonly label?: () => string | undefined;
    /** What it holds right now: `value`, `open`, the chosen choice's words. */
    readonly state: () => Readonly<Record<string, ControlStateValue>>;
    readonly choices?: () => readonly ControlChoice[];
    readonly actions: () => ControlActions;
}

let registry: Map<string, AgentControl> | undefined;
let sequence = 0;

/** Starts keeping the record (dev builds only, before the app mounts); answers the live record, keyed by ref (`c12`). */
export const armAgentControls = (): ReadonlyMap<string, AgentControl> => {
    registry ??= new Map();
    return registry;
};

/** Registers this component's control for as long as it is mounted, when the record is kept; otherwise nothing. */
export const useAgentControl = (control: AgentControl): void => {
    if (registry === undefined) {
        return;
    }
    const kept = registry;
    const ref = `c${++sequence}`;
    onMounted(() => kept.set(ref, control));
    onBeforeUnmount(() => kept.delete(ref));
};

/**
 * Actions a component built on another adds to the control that one registers: <ConfirmDialog>'s confirm and cancel,
 * on the <Modal> it is drawn in. The receiver provides `undefined` again under itself, so a dialog opened from inside
 * a confirm's body doesn't take the confirm's buttons too.
 */
export const EXTRA_CONTROL_ACTIONS: InjectionKey<(() => ControlActions) | undefined> = Symbol(`extraControlActions`);
