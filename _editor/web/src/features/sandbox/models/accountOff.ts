import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { newestRefusal } from "@intentic/sandbox-contract/models/plan-pools";
import { formatClock, formatDayMonthTime } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { providerRefusals } from "../../../models/providers/providerAccounts";

/* AN ACCOUNT SOMEBODY ELSE TURNED OFF, READ AT A GLANCE. Its row used to print the provider's sentence alone ("Your
   organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead…"), which a
   reader had to parse to learn that the account is off, why, and that nothing here turns it back on. The row now leads
   with that, and since when where the refusal on file says so; the provider's own words follow, whole in the row's hover. */

// The moment as the row says it: the clock for today, the day and the clock before that.
const sinceWords = (at: number, now: number): string => (new Date(at).toDateString() === new Date(now).toDateString() ? formatClock(at) : formatDayMonthTime(at));

/** The status line of an account an organisation or a plan turned off: off, by whom, since when, then the provider's words. */
export const accountOffLine = (provider: AgentProvider, providerName: string, account: string, reason: string, now: number = Date.now()): string => {
    const refused = (providerRefusals.value[provider] ?? []).filter((refusal) => refusal.kind === `entitlement` && refusal.account === account);
    const at = newestRefusal(refused)?.at;
    const off =
        at === undefined
            ? t(`sandbox.aiAccountSection.offByAdmin`, { provider: providerName })
            : t(`sandbox.aiAccountSection.offByAdminSince`, { provider: providerName, when: sinceWords(at, now) });
    const said = reason.trim();
    return said === `` ? off : `${off} · ${said}`;
};
