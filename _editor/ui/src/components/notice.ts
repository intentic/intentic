import type { IconName } from "../icons/iconSets.js";

/* WHAT A FAILURE IS, ONCE, FOR THE WHOLE APP — the data behind <Notice> and <NoticeStack>.
 *
 * Every view used to report failure as a `ui.alertDanger()` div holding an interpolated string, and the string
 * was whatever the throw site carried: "fetch failed", a 413, a line of git porcelain. Two things were wrong
 * with that and neither is cosmetic. The user read our internals and got no idea what it meant for their work.
 * And nothing said what to do next, so a failure the app was already retrying and a dead end looked identical.
 *
 * So a notice is a SENTENCE THE APP WROTE (`title`), the raw cause kept underneath for whoever wants it
 * (`detail`), and AT MOST ONE way out (`action`). All three parts are load-bearing:
 *
 * `detail` is optional because a title that already says everything must not repeat itself.
 *
 * `action` is optional because NO ACTION IS A REAL ANSWER. A failure the app is already healing must not offer
 * a button — a button there invites the user to fix something that isn't broken. That distinction is the
 * connecting gate's (sandbox-gates/connectionNotice.ts, which had it right first), applied to everything else.
 *
 * `tone` decides ORDER when several are on screen, which is the other half of the problem: a view with four
 * sources of failure stacked four independent boxes in template order, and template order is not severity. */

export type NoticeTone = "danger" | "warning" | "info";

export interface NoticeAction {
    readonly label: string;
    readonly run: () => void;
}

export interface NoticeModel {
    // `danger` broke what the user was doing; `warning` will break something if ignored; `info` is a standing
    // fact they may want and never have to act on.
    readonly tone: NoticeTone;
    // The app's own words. Never a caught message — those go in `detail`.
    readonly title: string;
    // The raw cause, when it says something the title doesn't.
    readonly detail?: string;
    readonly action?: NoticeAction;
    /* Identity, for the stack's duplicate collapsing. Defaults to the title, which is right whenever the same
     * failure produces the same sentence — give an explicit key only when one sentence covers several distinct
     * failures that should each still be shown. */
    readonly key?: string;
}

/* The tints the app already used for inline alerts, kept exactly: a migration that also restyled every error
 * box in the product would be impossible to review.
 *
 * They live here rather than on `ui` because <Notice> is now the only way to draw one. As a public recipe this
 * was a second, quieter answer to the same question — same tint, same border, same padding, no icon, no ARIA
 * role, no dismiss — and thirty-two views had taken it, so which of the two a reader got came down to whether
 * the sentence happened to contain a `<code>` tag.
 *
 * Spelled out per tone rather than built from a `border-${tone}/40` template, which is the mistake the series
 * palette records in semantic-colors.css: Tailwind emits a utility only where it can SEE the name, so a class
 * assembled at runtime is a class that ships as nothing at all. */
export const NOTICE_BOX: Record<NoticeTone, string> = {
    danger: `flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger`,
    warning: `flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning`,
    info: `flex items-start gap-2 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-xs text-info`,
};

export const NOTICE_ICON: Record<NoticeTone, IconName> = {
    danger: `exclamation-triangle`,
    warning: `exclamation-circle`,
    info: `info-circle`,
};

export const noticeKey = (notice: NoticeModel): string => notice.key ?? notice.title;

/* WHICH FAILURE THE USER READS FIRST, decided here instead of by whichever component rendered last.
 *
 * SEVERITY FIRST, stable within a tone — two equally-bad failures keep the order their view raised them in,
 * which is the only ordering their view knows anything about. The index tie-break is explicit rather than
 * leaning on sort stability, so the guarantee survives an edit to the comparator.
 *
 * ONE VOICE PER PROBLEM. The same failure reaching a view through three queries is one problem, and saying it
 * three times reads as three. The FIRST of a duplicate set survives rather than the last, so a notice that
 * carries a detail line or an action does not lose it to a barer copy raised afterwards. */
const SEVERITY: readonly NoticeTone[] = [`danger`, `warning`, `info`];

export const rankNotices = (notices: readonly NoticeModel[]): readonly NoticeModel[] => {
    const seen = new Set<string>();
    const unique = notices.filter((notice) => {
        const key = noticeKey(notice);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    return unique
        .map((notice, index) => ({ notice, index }))
        .toSorted((left, right) => SEVERITY.indexOf(left.notice.tone) - SEVERITY.indexOf(right.notice.tone) || left.index - right.index)
        .map((entry) => entry.notice);
};
