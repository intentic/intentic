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
export const VERB_LABEL: Record<Exclude<SandboxVerb, `logs`>, string> = {
    start: `Start`,
    stop: `Stop`,
    restart: `Restart`,
    update: `Update`,
    rollback: `Roll back`,
    resources: `Resources…`,
    remove: `Remove`,
};

// One place, since the two apps used to ask differently about the same thing. Only the three hard- or
// slow-to-undo verbs ask at all; `resources` asks nothing here since its own form is the confirmation.
export interface SandboxVerbPrompt {
    /** The question, naming the sandbox: a dialog header, or a native dialog's title. */
    readonly header: string;
    /** What agreeing does, and what survives it: the dialog's prose. */
    readonly body: string;
}

export const sandboxVerbPrompt = (verb: SandboxVerb, name: string): SandboxVerbPrompt | undefined => {
    switch (verb) {
        case `remove`:
            return {
                header: `Remove ${name}?`,
                body: `This deletes the sandbox and everything in it — its files and its history — from that device. This cannot be undone.`,
            };
        case `update`:
            return {
                header: `Update ${name}?`,
                body: `The sandbox restarts onto the newest image and is unavailable while that happens — seconds if the update is already downloaded, a few minutes if not. Its files are kept.`,
            };
        case `rollback`:
            return {
                header: `Roll ${name} back?`,
                body: `The sandbox restarts onto the image it ran before its last update. Its files are kept.`,
            };
        default:
            return undefined;
    }
};
