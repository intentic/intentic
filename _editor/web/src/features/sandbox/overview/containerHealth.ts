import type { SandboxSummary } from "@intentic/api-contract";

/* WHAT IS WRONG WITH THIS SANDBOX THAT WAITING WILL NOT FIX, decided in one pure place beside the views that
 * draw it (the setupReport.ts and setupCompose.ts pattern).
 *
 * The platform already carries three separate accounts of a sandbox's health, all posted by the box itself over
 * the outbound channel that survives its own tunnel being down: `bootReport.drift` (env it was set up before),
 * `bootReport.reach` (whether its public address answered), and `announceRefusal` (a check-in the platform
 * turned away). Until this module, every one of them was read by exactly ONE screen — the setup wizard — which
 * gives up five minutes after a sandbox is created and never runs again.
 *
 * That is why a sandbox can be degraded for eight days and look perfect: the diagnosis existed, was accurate,
 * was delivered, and had nowhere to appear. Nothing here is new evidence; it is the same evidence, read where
 * somebody is actually looking.
 *
 * TWO RULES, both of them about not crying wolf:
 *
 *   • SETTLED ONLY. A sandbox whose tunnel is thirty seconds from coming up is `unreachable` too, and saying so
 *     on a workspace that is about to start working is how a warning becomes furniture. The daemon already
 *     draws the line for us (`retrying`, reach-report.ts: false means the verdict is final and only a setup run
 *     changes it), and a gap in `drift` is settled by construction. Nothing transient reaches this module's
 *     output — that remains the wizard's job, during the window where somebody is watching it.
 *
 *   • ONE CAUSE, ONE NOTICE. Drift is WHY the address does not answer, so a container reporting both must say
 *     the first and not the second: two cards describing one fault read as two faults, and the reader fixes the
 *     shallower one. Reported causes are ranked, and only the deepest survives. */

// The three faults, deepest cause first — the array's order IS the ranking (see `containerNotices`).
export type ContainerFault = "drift" | "unreachable" | "refused";

export interface ContainerNotice {
    readonly fault: ContainerFault;
    // A heading in the product's terms. Never the env's: nobody browsing Devices knows what a grant is.
    readonly title: string;
    // What it costs, rendered VERBATIM — every string here was written by the daemon or the requirements table
    // for the person who has to act, and re-wording it in a component is how the two drift apart.
    readonly detail: string;
    // The one move that fixes it, when there is one to name.
    readonly repair?: string;
    // The env this container is missing, for a bug report or a `docker inspect` check. Drift only.
    readonly keys?: readonly string[];
}

/* The evidence, as the sandbox list already carries it. Shaped as a `Pick` rather than the whole summary so the
 * caller passes facts it holds and this module cannot start reaching for anything it was not given. */
export type ContainerEvidence = Pick<SandboxSummary, "bootReport" | "announceRefusal">;

/* Every settled fault this sandbox is reporting, deepest cause first, and NEVER a shallower one it explains.
 *
 * Empty is the normal answer and the one that must stay cheap to reach: a healthy sandbox produces no notice,
 * so a view can render this array directly and draw nothing at all when there is nothing to say. */
export const containerNotices = (sandbox: ContainerEvidence): readonly ContainerNotice[] => {
    const report = sandbox.bootReport;

    /* THE DEEPEST CAUSE. A container set up before something it now needs, named key by key. This is the only
     * fault here that no amount of restarting, rebuilding or updating can clear — a recreate replays the env of
     * the container it replaces, so it can only carry the absence forward — which is exactly why it outranks
     * the symptom below it. */
    const drift: ContainerNotice[] = (report?.drift ?? []).map((gap) => ({
        fault: "drift",
        title: `This sandbox was set up before it needed ${gap.enables}`,
        detail: gap.lost,
        repair: gap.repair,
        keys: gap.missing,
    }));
    if (drift.length > 0) {
        return drift;
    }

    /* THE SYMPTOM, shown only when nothing above explains it, and only on an EXPLICIT `false`.
     *
     * `retrying === false` is the daemon saying it has stopped and will not start again on its own. Absent is a
     * third answer, not a quiet yes: a daemon older than this field reports `unreachable` throughout a perfectly
     * normal setup, so reading absence as "settled" would grow a permanent fault card on every sandbox still
     * running last release's image. Such a daemon sends no `drift` either, so it says nothing here at all —
     * which is the honest output for a box that has not been asked the question. */
    if (report?.reach === `unreachable` && report.retrying === false) {
        return [
            {
                fault: "unreachable",
                title: `This sandbox does not answer at its public address`,
                detail: report.detail ?? `Its public address did not answer when the sandbox checked it from the inside.`,
            },
        ];
    }

    /* A DISAGREEMENT ABOUT WHERE IT LIVES: the box announced an address the platform will not record for it, so
     * every reader is pointed somewhere the sandbox is not. Independent of the two above — a container can be
     * perfectly equipped and still be announcing the wrong name — so it is reported when they are silent. */
    const refusal = sandbox.announceRefusal;
    if (refusal !== null && refusal !== undefined) {
        return [
            {
                fault: "refused",
                title: `This sandbox is checking in under an address the platform does not hold for it`,
                detail: `It announced ${refusal.announced}, while the platform has ${refusal.expected} on record. Until the two agree, anything sent to the recorded address misses it.`,
            },
        ];
    }

    return [];
};

/* Does this sandbox have anything settled wrong with it? The one-line form, for a nav badge or a row's dot —
 * callers that want to know THAT rather than WHAT, without paying for the notices they will not render. */
export const hasContainerFault = (sandbox: ContainerEvidence): boolean => containerNotices(sandbox).length > 0;
