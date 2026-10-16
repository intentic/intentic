import type { ViewBadge } from "@intentic/extension-api";
import type { ApprovalsList, HookRequests } from "@intentic/sandbox-contract/schemas/approvals";
import { waitingHooksOf } from "./useHookRequests";
import { t } from "./i18n.js";

// What this queue owes a person, as the tile's badge: a proposal owing a yes, a failure owing a retry, a hook set owing
// a yes or a no, and a record that could not be read. Held wakes are not counted: the board draws each as a card and the
// Agents tile counts it, so a second number here would be the same wait twice. Pure, so the rule is tested without a host.

// The two reads the badge is built from, as the poll last saw them. Absent hooks: not a maintainer's, or not read.
export interface QueueSnapshot {
    readonly list?: ApprovalsList | undefined;
    readonly hooks?: HookRequests | undefined;
}

export const owedBadge = (snapshot: QueueSnapshot | undefined): ViewBadge | undefined => {
    const approvals = snapshot?.list?.approvals ?? [];
    const failed = approvals.filter((item) => item.status === `failed`).length;
    const proposed = approvals.filter((item) => item.status === `proposed`).length;
    const unreadable = snapshot?.list?.invalid.length ?? 0;
    const hooks = waitingHooksOf(snapshot?.hooks).length;
    const ledger = snapshot?.hooks?.ledgerUnreadable === true;
    // Worst first, as the page's sections run: what already broke, then what waits for a first yes.
    const parts = [
        failed > 0 ? t(`owed.failed`, { count: failed }, failed) : undefined,
        unreadable > 0 ? t(`owed.unreadable`, { count: unreadable }, unreadable) : undefined,
        ledger ? t(`owed.ledger`) : undefined,
        proposed > 0 ? t(`owed.proposed`, { count: proposed }, proposed) : undefined,
        hooks > 0 ? t(`owed.hooks`, { count: hooks }, hooks) : undefined,
    ].filter((part) => part !== undefined);
    if (parts.length === 0) {
        return undefined;
    }
    // An unreadable hook record is one thing owed, whatever it held: with it unread, no workspace hook runs at all.
    const count = failed + unreadable + proposed + hooks + (ledger ? 1 : 0);
    return { count, tone: failed > 0 || unreadable > 0 || ledger ? `danger` : `warning`, tooltip: parts.join(` · `) };
};
