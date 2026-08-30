/* WHAT CAN BE DONE TO ONE SANDBOX ON ONE COMPUTER, the vocabulary behind SandboxVerbs.vue.
 *
 * Structural rather than the sandbox contract's own `MachineSandboxOp`, for the reason machineDetail.ts states:
 * `@intentic/ui` carries no domain dependency. The two callers do, the web tab sends these straight down the
 * machine route, the desktop app maps them onto its own Tauri commands, and both satisfy this by shape.
 *
 * `rebuild` is deliberately NOT here. It takes the owner-approved overlay's digest, which is knowable only where
 * that approval lives (the Environment card), so a button for it on a row that has no digest to send would be a
 * verb that fails on click. Both apps reach a rebuild from the same place, and neither offers it here. */
export type SandboxVerb = `start` | `stop` | `restart` | `update` | `rollback` | `logs` | `remove`;

/* ONE BUTTON ON THE ROW, AND THE REST BEHIND A MENU, decided once for both apps.
 *
 * All six used to sit on the row as equal text buttons. On a machine running four sandboxes that is twenty-four
 * controls on one screen, in one weight, and the row's own NAME lost to them: the thing a reader scans for was
 * the quietest object on the line it titled. Worse, the one verb nothing undoes sat a few pixels from the one
 * that rolls an image back, in a cluster where every other neighbour is harmless.
 *
 * So the row keeps the verb people actually reach for, the container's power state, which is what the row's own
 * dot is about, and everything else moves one deliberate click away. Start and Stop are the same slot in two
 * states: a stopped sandbox has nothing to stop, and a running one is not started twice. */
export const primaryVerb = (running: boolean): Extract<SandboxVerb, `start` | `stop`> => (running ? `stop` : `start`);

/* THE MENU, IN READING ORDER. Restart belongs beside the power button it is a variant of; the log tail is the
 * one that only READS and is reached most; then the two that move the container onto another image, newest-first
 * (`update`) then backwards (`rollback`). Removal is last, alone, and the caller draws the divider, it is the
 * only irreversible thing here and it should never be the neighbour of anything.
 *
 * Restart is absent on a stopped sandbox because Start already covers it, which is the same reasoning that keeps
 * Stop off that row. */
export const menuVerbs = (running: boolean): readonly SandboxVerb[] => [...(running ? ([`restart`] as const) : []), `logs`, `update`, `rollback`];

// The one that stands apart, named rather than sliced off the list above so a reader of either app can see why
// it is drawn where it is.
export const DESTRUCTIVE_VERB = `remove` satisfies SandboxVerb;

// What each one is called on the button. `logs` says which way the toggle goes, so it is labelled by its caller.
export const VERB_LABEL: Record<Exclude<SandboxVerb, `logs`>, string> = {
    start: `Start`,
    stop: `Stop`,
    restart: `Restart`,
    update: `Update`,
    rollback: `Roll back`,
    remove: `Remove`,
};

/* THE SENTENCES EACH DESTRUCTIVE-ENOUGH VERB ASKS BEFORE IT RUNS, in one place because the two apps used to
 * ask differently about the same thing, one named what is lost, the other named the slug and stopped there.
 * Structured as a question and its consequence because the two land in different slots: the web tab's
 * ConfirmDialog takes a header and body, and the desktop app's native dialog takes a title and message —
 * one `\n\n`-joined string forced both to re-split it or render it wrong.
 *
 * Every consequence keeps the SANDBOX as its subject. "It restarts on that computer" read to real people as
 * "that computer restarts", which is a much bigger thing to be asked to agree to than what happens.
 *
 * Only the three that are hard or slow to undo ask at all: start, stop, restart and a log tail are all undone by
 * doing the opposite, and a confirmation on those is a click tax that teaches people to dismiss dialogs. */
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
                body: `This deletes the sandbox and everything in it — its files and its history — from that computer. This cannot be undone.`,
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
