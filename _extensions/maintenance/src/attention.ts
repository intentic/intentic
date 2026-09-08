import { assessReport, type ChoreVerdict, ledgerKey, unseenVerdicts } from "@intentic/sandbox-contract/chores";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxLedger, sandboxPoll } from "@intentic/extension-api";
import { STATE_DIR } from "@intentic/sandbox-contract";
import { choresReportQuery } from "./choresQuery";
import { host } from "./host";

// The rail badge counts chores whose evidence changed since the owner last looked, not due chores (always non-zero) or
// findings (forty packages is one situation, not forty claims); it clears by looking. The three filters live in
// `unseenVerdicts`, so the panel agrees with the tile on what is new:
// due: the obvious one
// not settled: a turn has already been spent on exactly this evidence
// unseen digest: the owner has already seen this evidence in the panel

// Last acknowledged digest per repo|chore, as a file so it survives reloads and syncs across browsers. New evidence
// gets a new digest, so today's acknowledgement can't swallow tomorrow's.
const seen = sandboxLedger(host, `${STATE_DIR}/records/chores/seen.json`);

// Module state, not the view's query: an unmounted view is never observed. Reads through the host's cache, sharing the
// panel's own fetch; slow on purpose, matching how rarely probes refresh.
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
    // `warning` only for a currently-carried risk; everything else is `info`. `danger` is never used here.
    const carrying = unseen.value.filter((verdict) => verdict.severity === `warning`);
    const subject = carrying.length > 0 ? carrying : unseen.value;
    return {
        count,
        tone: carrying.length > 0 ? `warning` : `info`,
        tooltip: `${subject.length === 1 ? `` : `${subject.length} chores, newest: `}${subject[0]?.chore.title}, ${subject[0]?.headline}`,
    };
};

// Marks the evidence actually on screen as seen, per digest so tomorrow's finding isn't swallowed by today's. Only due
// verdicts are written; acknowledging a clear one would bank a digest never shown.
export const acknowledge = async (verdicts: readonly ChoreVerdict[]): Promise<void> => {
    const due = verdicts.filter((verdict) => verdict.state === `due`);
    if (due.length === 0) {
        return;
    }
    // Clears the badge only if the write actually landed; a mid-write switch must not silence it early.
    if (await seen.mark(Object.fromEntries(due.map((verdict) => [ledgerKey(verdict.repo, verdict.chore.id), verdict.digest])))) {
        unseen.value = unseen.value.filter((verdict) => !due.includes(verdict));
    }
};
