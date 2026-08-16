/* WHAT CAN BE DONE TO ONE SANDBOX ON ONE COMPUTER — the vocabulary behind SandboxVerbs.vue.
 *
 * Structural rather than the sandbox contract's own `MachineSandboxOp`, for the reason machineDetail.ts states:
 * `@intentic/ui` carries no domain dependency. The two callers do — the web tab sends these straight down the
 * machine route, the desktop app maps them onto its own Tauri commands — and both satisfy this by shape.
 *
 * `rebuild` is deliberately NOT here. It takes the owner-approved overlay's digest, which is knowable only where
 * that approval lives (the Environment card), so a button for it on a row that has no digest to send would be a
 * verb that fails on click. Both apps reach a rebuild from the same place, and neither offers it here. */
export type SandboxVerb = `start` | `stop` | `restart` | `update` | `rollback` | `logs` | `remove`;

/* THE ROW, IN READING ORDER, decided once for both apps.
 *
 * Power first, because it is what the row's own dot is about; then the two that move the container onto another
 * image, newest-first (`update`) then backwards (`rollback`); then the one that only reads; then, last and alone
 * in red, the one that cannot be undone.
 *
 * Start and Stop/Restart are the same slot in two states — a stopped sandbox has nothing to restart, and a
 * running one is not started twice — which is why this is computed from `running` rather than filtered by the
 * template. Red means exactly one thing on this row: everything but removal is secondary, so the eye finds the
 * machine's own state before it finds a verb. */
export const sandboxVerbs = (running: boolean): readonly SandboxVerb[] => [
    ...(running ? ([`restart`, `stop`] as const) : ([`start`] as const)),
    `update`,
    `rollback`,
    `logs`,
    `remove`,
];

// What each one is called on the button. `logs` says which way the toggle goes, so it is labelled by its caller.
export const VERB_LABEL: Record<Exclude<SandboxVerb, `logs`>, string> = {
    start: `Start`,
    stop: `Stop`,
    restart: `Restart`,
    update: `Update`,
    rollback: `Roll back`,
    remove: `Remove`,
};

/* THE SENTENCE EACH DESTRUCTIVE-ENOUGH VERB ASKS BEFORE IT RUNS, in one place because the two apps used to ask
 * differently about the same thing — one named what is lost, the other named the slug and stopped there.
 *
 * Only the three that are hard or slow to undo ask at all: start, stop, restart and a log tail are all undone by
 * doing the opposite, and a confirmation on those is a click tax that teaches people to dismiss dialogs. */
export const sandboxVerbPrompt = (verb: SandboxVerb, name: string): string | undefined => {
    switch (verb) {
        case `remove`:
            return `Remove ${name}?\n\nThis deletes it and everything in it — its files and its history — from that computer. This cannot be undone.`;
        case `update`:
            return `Update ${name}?\n\nIt restarts onto the newest image and is unavailable for a few minutes. Its files are kept.`;
        case `rollback`:
            return `Roll ${name} back?\n\nIt returns to the image it ran before its last update. Its files are kept.`;
        default:
            return undefined;
    }
};
