import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { ModelRef } from "@intentic/sandbox-contract/models/plan-pools";
import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { sandboxNow } from "../../agent-status/sandboxClock";
import { refusalsOf } from "./doorFacts";
import { liveUsage, type PlanHeadroom, planHeadroom } from "../usageStatus";

// Run-outs shared across sandboxes (docs/architecture/account-routing.md, 2026-11-24): a spent allowance another of the
// owner's sandboxes signed in to the same account met is on this sandbox's ledger as `source: "another-sandbox"`. The
// reading already draws it spent (the contract's rule lays every standing refusal on); this says where it was seen, since
// nothing this sandbox ran spent it.

/** A headroom with, where it applies, when another sandbox on the same account ran it out (epoch ms). */
export type AccountHeadroom = PlanHeadroom & { readonly heardRunOut?: number };

/** When another sandbox on the same account last ran it out, while that run-out stands; undefined otherwise. */
export const heardRunOut = (provider: AgentProvider, account: string, now: number = sandboxNow()): number | undefined => {
    const heard = refusalsOf(provider).filter(
        (refusal) =>
            refusal.source === `another-sandbox` &&
            refusal.account === account &&
            (refusal.resetsAt === undefined || refusal.resetsAt * 1000 > now),
    );
    return heard.length === 0 ? undefined : Math.max(...heard.map((refusal) => refusal.at));
};

/** An account's headroom as every meter draws it (liveUsage, planHeadroom), and whether another sandbox ran it out. */
export const accountHeadroom = (
    provider: AgentProvider,
    account: string | undefined,
    { attached, model }: { readonly attached?: AccountUsage | undefined; readonly model?: ModelRef | undefined } = {},
): AccountHeadroom | undefined => {
    if (account === undefined) {
        return undefined;
    }
    const headroom = planHeadroom(liveUsage(provider, account, attached, model), model);
    const heard = heardRunOut(provider, account);
    return headroom === undefined || heard === undefined ? headroom : { ...headroom, heardRunOut: heard };
};
