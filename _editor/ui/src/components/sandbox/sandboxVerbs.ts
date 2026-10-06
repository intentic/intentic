import { t } from "../../i18n/index.js";

// What can be done to one sandbox on one device, the vocabulary behind SandboxVerbs.vue. Structural
// rather than the sandbox contract's own `DeviceSandboxOp`. `rebuild` is deliberately absent: it needs
// the approved overlay's digest, only knowable from the Environment card.
export type SandboxVerb = `start` | `stop` | `restart` | `update` | `rollback` | `resources` | `logs` | `remove`;

// One button on the row, the rest behind a menu: the container's power state is what the row's dot is
// about and what people reach for most; everything else is one click away. Start/Stop are one slot in
// two states.
export const primaryVerb = (running: boolean): Extract<SandboxVerb, `start` | `stop`> => (running ? `stop` : `start`);

// The menu, in reading order: restart beside the power button it varies; the log tail, reached most;
// then a reshape that keeps the image; then update/rollback, newest-first. Removal is last and alone.
export const menuVerbs = (running: boolean): readonly SandboxVerb[] => [
    ...(running ? ([`restart`] as const) : []),
    `logs`,
    `resources`,
    `update`,
    `rollback`,
];

// The one verb that stands apart, named here so a reader of either app can see why it's placed last.
export const DESTRUCTIVE_VERB = `remove` satisfies SandboxVerb;

// What each verb is called on the button. `logs` is labelled by its caller, since it says which way the
// toggle goes; `resources` gets an ellipsis, the menu convention for "opens a form" rather than acting.
// Getters, so each read says the word in the language on screen now rather than the one the page booted in.
export const VERB_LABEL: Readonly<Record<Exclude<SandboxVerb, `logs`>, string>> = {
    get start() {
        return t(`ui.action.start`);
    },
    get stop() {
        return t(`ui.action.stop`);
    },
    get restart() {
        return t(`ui.action.restart`);
    },
    get update() {
        return t(`ui.action.update`);
    },
    get rollback() {
        return t(`ui.sandboxSandboxVerbs.rollBack`);
    },
    get resources() {
        return t(`ui.sandboxSandboxVerbs.resources`);
    },
    get remove() {
        return t(`ui.action.remove`);
    },
};

// One place, since the two apps used to ask differently about the same thing. Only the three hard- or
// slow-to-undo verbs ask at all; `resources` asks nothing here since its own form is the confirmation.
export interface SandboxVerbPrompt {
    /** The question, naming the sandbox: a dialog header, or a native dialog's title. */
    readonly header: string;
    /** What agreeing does, and what survives it: the dialog's prose. */
    readonly body: string;
}

// ONE OF THE VERSIONS A MACHINE KEPT, as the row's Roll back offers it. `to` is what the machine is sent to name it (a
// version, or the pinned image when it would not say), and absent for the newest, which is where a plain rollback goes
// anyway. Offered only by a caller whose machine can take `to` at all.
export interface RollbackChoice {
    readonly version: string;
    readonly to: string | undefined;
}

/** The question before going back to an older version than the one before, naming it. */
export const rollbackToPrompt = (name: string, version: string): SandboxVerbPrompt => ({
    header: t(`ui.sandboxSandboxVerbs.rollBackToHeader`, { name, version }),
    body: t(`ui.sandboxSandboxVerbs.sandboxRestartsOntoVersion`, { version }),
});

export const sandboxVerbPrompt = (verb: SandboxVerb, name: string): SandboxVerbPrompt | undefined => {
    switch (verb) {
        case `remove`:
            return {
                header: t(`ui.sandboxSandboxVerbs.removeHeader`, { name }),
                body: t(`ui.sandboxSandboxVerbs.deletesSandboxEverythingIn`),
            };
        case `update`:
            return {
                header: t(`ui.sandboxSandboxVerbs.updateHeader`, { name }),
                body: t(`ui.sandboxSandboxVerbs.sandboxRestartsOntoNewest`),
            };
        case `rollback`:
            return {
                header: t(`ui.sandboxSandboxVerbs.rollBackHeader`, { name }),
                body: t(`ui.sandboxSandboxVerbs.sandboxRestartsOntoImage`),
            };
        default:
            return undefined;
    }
};
