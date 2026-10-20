import { sandboxRef } from "@intentic/extension-api";
import { type AgentHarness, AgentHarnessSchema, type AgentLoop, type AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { capabilitiesOf, limitationsOf, loopOf, loopsOf, termsOf } from "@intentic/sandbox-contract/models/agent-catalog";

// Which loops a chat may put each provider on: what the daemon behind this window advertised (`providers.list`
// `loops`), never more, since a loop it does not run would be refused or silently run as its default. The functions
// taking `offered` are pure; `offeredLoops` reads this sandbox's own listing.

/** The listing's `loops` field as it arrived, or undefined from a daemon older than the field. */
export type AdvertisedLoops = Readonly<Record<string, readonly string[]>> | undefined;

// A value this build's enum knows; a newer daemon's loop is skipped rather than offered under no name.
const knownLoop = (value: string): value is AgentLoop => value !== `native` && AgentHarnessSchema.safeParse(value).success;

/** The loops a provider is offered on, its default first; more than one is a choice. */
export const offeredLoopsFrom = (advertised: AdvertisedLoops, provider: AgentProvider): readonly AgentLoop[] => {
    if (advertised === undefined) {
        // Every daemon before the field ran each provider natively and through Claude Code, and nothing else.
        const [own, ...rest] = loopsOf(provider);
        return own === undefined ? [loopOf(provider, `native`)] : [own, ...rest.filter((loop) => loop === `claude-code`)];
    }
    const [head, ...rest] = advertised[provider] ?? [];
    // A default this build cannot name is still what `native` runs there, so the chip that stores `native` stands for it.
    const own = head !== undefined && knownLoop(head) ? head : loopOf(provider, `native`);
    return [own, ...new Set(rest.filter(knownLoop).filter((loop) => loop !== own))];
};

/** The chip a stored harness lights: the loop it names where offered, else the default `native` resolves to. */
export const selectedLoop = (offered: readonly AgentLoop[], harness: AgentHarness): AgentLoop =>
    harness !== `native` && offered.includes(harness) ? harness : offered[0]!;

/** What a chip stores: `native` for the default (the spelling every daemon reads), the loop's own name otherwise. */
export const harnessOfLoop = (offered: readonly AgentLoop[], loop: AgentLoop): AgentHarness => (loop === offered[0] ? `native` : loop);

/** A stored harness as it would run here: a loop no longer offered, or the default named outright, reads as `native`. */
export const offeredHarness = (offered: readonly AgentLoop[], harness: AgentHarness): AgentHarness =>
    harnessOfLoop(offered, selectedLoop(offered, harness));

/** What the loop a stored harness runs on here cannot do; a loop no longer offered is not the one that runs. */
export const limitationsOn = (provider: AgentProvider, offered: readonly AgentLoop[], harness: AgentHarness): string[] =>
    limitationsOf(capabilitiesOf(provider, selectedLoop(offered, harness)));

/** Whether the harness row (LoopChips) has anything to draw: a choice to offer, or, for the loop the pick runs on, a limit
 *  or a vendor's terms to state. Hosts read it to decide whether the "how it runs" group shows at all. */
export const loopRowShown = (provider: AgentProvider, offered: readonly AgentLoop[], harness: AgentHarness, choosable = true): boolean =>
    (choosable && offered.length > 1) || limitationsOn(provider, offered, harness).length > 0 || termsOf(provider, selectedLoop(offered, harness)) !== undefined;

/** Another offered loop free of every limit the current one has, which is the one worth naming beside them. */
export const liftingLoop = (provider: AgentProvider, offered: readonly AgentLoop[], harness: AgentHarness): AgentLoop | undefined => {
    const current = selectedLoop(offered, harness);
    const limits = limitationsOn(provider, offered, harness);
    if (limits.length === 0) {
        return undefined;
    }
    return offered.find((loop) => loop !== current && limitationsOf(capabilitiesOf(provider, loop)).every((limit) => !limits.includes(limit)));
};

// This sandbox's listing, read with the rest of `providers.list` (useChat-catalog.ts); a switch clears it with the scope.
export const advertisedLoops = sandboxRef<AdvertisedLoops>(() => undefined);

/** The loops this sandbox's daemon offers the provider on, its default first. */
export const offeredLoops = (provider: AgentProvider): readonly AgentLoop[] => offeredLoopsFrom(advertisedLoops.value, provider);
