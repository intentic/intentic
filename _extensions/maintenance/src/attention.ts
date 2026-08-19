import { assessReport, type ChoreVerdict, ledgerKey, unseenVerdicts } from "@intentic/sandbox-contract/chores";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxLedger, sandboxPoll } from "@intentic/extension-api";
import { STATE_DIR } from "@intentic/sandbox-contract";
import { choresReportQuery } from "./choresQuery";
import { host } from "./host";

/* THE RAIL BADGE, and the several things it is deliberately NOT.
 *
 * It is not a count of due chores. That number is a STATISTIC — it will be non-zero in every real repository
 * every day forever, and the extension API is explicit about why that is a bug rather than information: a badge
 * "must mean something happened here that you don't already know about, never here is a statistic", because a
 * tile that is always lit teaches the eye to stop seeing the rail. This surface is the one most at risk of that,
 * since its whole subject is work that is permanently outstanding.
 *
 * It is not a count of findings either. Forty outdated packages is one situation, not forty claims on anyone's
 * attention.
 *
 * What it counts is chores whose EVIDENCE HAS CHANGED since the owner last looked at them: a new advisory landed,
 * a package appeared that nothing documents, a file entered the top of the hotspot ranking. That is an event, it
 * is addressed to the person seeing it, and it clears by LOOKING — opening the view acknowledges the evidence
 * currently on screen — rather than by finishing anything. The chores stay due, visibly, inside the panel; the
 * rail simply stops repeating itself.
 *
 * Three filters get us there, and they live in the chore book (unseenVerdicts) rather than here, because the
 * panel has to agree with the tile about what is new:
 *   state === due    the obvious one
 *   not settled      a turn has already been spent on exactly this evidence
 *   unseen digest    the owner has already seen this evidence in the panel */

/* What the badge has already been shown, keyed repo|chore → the digest last acknowledged. A file rather than an
 * extension setting: the badge is derived from files, so its acknowledgement belongs in the same tree, where it
 * survives a reload and is shared across the owner's browsers without adding a setting no user would ever type.
 *
 * The digest IS the mark, which is what makes this a comparing ledger rather than a presence one: the same chore
 * with new evidence has a new digest and is therefore new again, so acknowledging today's finding cannot swallow
 * tomorrow's. */
const seen = sandboxLedger(host, `${STATE_DIR}/records/chores/seen.json`);

/* The tile's whole source. Its own timer rather than the view's query — a badge that only updated while you were
 * already looking at Maintenance could never tell you anything you did not know, and nothing observes an
 * unmounted view, so neither the file push nor the panel's query can serve it (background.ts).
 *
 * The read goes THROUGH the host's cache, not straight at the route, so this poll and the panel are one read. It
 * was fetching precisely what the panel renders, six times an hour, and handing it to nobody else; the panel then
 * opened on a skeleton and asked again. Filed under the panel's key, the most recent poll IS what the panel
 * paints from the moment it is opened.
 *
 * Slow on purpose, and slower than any other attention poll in the workspace. Probes refresh on a daily-to-weekly
 * TTL, so the answer to "has anything changed" changes a few times a week; polling this faster would be spending
 * requests to re-learn the same thing. */
const { state: unseen, start: startMaintenanceAttention } = sandboxPoll<readonly ChoreVerdict[]>({
    host,
    everyMs: 10 * 60_000,
    initial: () => [],
    read: async (api) => unseenVerdicts(assessReport(await api.sandbox.fetch(choresReportQuery()), Date.now()), await seen.read()),
});

export { startMaintenanceAttention };

export const maintenanceBadge = (): ViewBadge | undefined => {
    const count = unseen.value.length;
    if (count === 0) {
        return undefined;
    }
    /* `warning` only for a risk the owner is CARRYING RIGHT NOW — a live high or critical advisory, a runtime past
     * its end-of-life date. Everything else stays `info`, including large and ugly numbers, because "there is a
     * lot of it" is not an emergency and a maintenance tile that reaches for warning routinely spends the one
     * signal that was worth having. `danger` is never used here: nothing in this book is BROKEN. */
    const carrying = unseen.value.filter((verdict) => verdict.severity === `warning`);
    const subject = carrying.length > 0 ? carrying : unseen.value;
    return {
        count,
        tone: carrying.length > 0 ? `warning` : `info`,
        tooltip: `${subject.length === 1 ? `` : `${subject.length} chores, newest: `}${subject[0]?.chore.title} — ${subject[0]?.headline}`,
    };
};

/* Acknowledge what is on screen. Called when the view is opened and whenever its verdicts change while it is
 * open, so "I have seen this" means exactly what it says: the digest of the evidence the reader was actually
 * shown. Per digest rather than per chore, so acknowledging today's finding cannot swallow tomorrow's.
 *
 * Only DUE verdicts are written. Acknowledging a clear chore would bank a digest that is not on screen and has
 * never been read, and the first time it became due it would already be silent. */
export const acknowledge = async (verdicts: readonly ChoreVerdict[]): Promise<void> => {
    const due = verdicts.filter((verdict) => verdict.state === `due`);
    if (due.length === 0) {
        return;
    }
    // Fold them out of the badge only if the acknowledgement actually landed: a switch mid-write abandons it,
    // and clearing here anyway would silence the NEW box's tile for evidence read in the old one.
    if (await seen.mark(Object.fromEntries(due.map((verdict) => [ledgerKey(verdict.repo, verdict.chore.id), verdict.digest])))) {
        unseen.value = unseen.value.filter((verdict) => !due.includes(verdict));
    }
};
