import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { t } from "@intentic/ui/i18n";
import { sandboxNow } from "../../agent-status/sandboxClock";
import { degradedOf } from "./doorFacts";
import { providerDisplayLabel } from "../providerCatalog";
import { formatWait } from "../usageStatus";
import { verdictNow } from "./verdictClock";

/* A PROVIDER FAILING TURNS FOR REASONS NO ACCOUNT'S ALLOWANCE EXPLAINS, in words: down (5xx, overloaded, unreachable), or
   turning every request away for a moment with a rate limit no allowance accounts for, as the daemon's outage breaker
   reports it on the provider's capacity (`degraded`), and when the sandbox tries it again. Said where a person chooses
   what to run on (the model picker's provider lane) and where they send (the composer's status line and Send's hover),
   since every account there may read full of room while every turn on them is failing. A daemon from before capacity
   reports nothing, and nothing is said. */

/** What a surface says of a degraded provider. */
export interface DegradedNote {
    // A word for a narrow row: "Down", "Throttling".
    readonly short: string;
    // The sentence naming the provider and what it is doing.
    readonly title: string;
    // When the sandbox tries it again; undefined once that instant has come, while the next capacity is on its way.
    readonly retry: string | undefined;
    // The title and the retry together, for a status line or a screen reader.
    readonly line: string;
}

/** What to say of `provider` while the daemon reports it degraded, at `now` (this browser's clock); else undefined. */
export const degradedNote = (provider: AgentProvider, now: number = verdictNow()): DegradedNote | undefined => {
    const degraded = degradedOf(provider);
    if (degraded === undefined) {
        return undefined;
    }
    const name = providerDisplayLabel(provider);
    const title = degraded.cause === `outage` ? t(`chat.providerDegraded.outage`, { provider: name }) : t(`chat.providerDegraded.throttle`, { provider: name });
    // The retry is the sandbox's instant; the wait is counted on its clock (sandboxNow).
    const at = sandboxNow(now);
    const retry = degraded.retryAt > at ? t(`chat.providerDegraded.retry`, { wait: formatWait(degraded.retryAt / 1_000, at) }) : undefined;
    return {
        short: degraded.cause === `outage` ? t(`chat.providerDegraded.outageShort`) : t(`chat.providerDegraded.throttleShort`),
        title,
        retry,
        line: retry === undefined ? title : `${title} · ${retry}`,
    };
};
