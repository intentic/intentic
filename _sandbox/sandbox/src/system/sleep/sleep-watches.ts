import { SLEEP_WATCHES_MAX, type SleepWatch } from "@intentic/api-contract/ingress";
import { type SleepWatch as SleepWatchDeclaration, sleepWatchConsented } from "@intentic/extension-manifest";
import { isVaulted } from "@intentic/sandbox-contract/policy/capability-secrets";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Logger } from "pino";
import { z } from "zod";
import type { AutomationRecord } from "../../automations/automations-store.js";
import type { Config } from "../../env.config.js";
import { callIngress } from "../platform-client.js";

/* WHAT A HOSTED MACHINE LETS THE PLATFORM HOLD WHILE IT SLEEPS (2026-11-27), the one exception to credentials staying in
 * the sandbox. Discord delivers a mention only down a live gateway connection, which sleeps with the machine; a card
 * that declares `sleepWatch` (Discord's) names the field its credential is in and the switch that is its owner's yes.
 * Right before a hosted sleep, once the stop is decided (platform-presence.ts `beforeStop`), the daemon hands the
 * platform the credential of every connection that has it all (its cards read by extensions/runtime/sleep-watch-cards.ts):
 * - this is a machine the platform hosts (never a sandbox on somebody's own computer, whatever its card says);
 * - the connection's consent switch is on;
 * - its card's extension owns the provider's listener, and an enabled automation listens on that provider.
 * The platform holds them until any word from the waking daemon (api sleep-watch.ts). A connection whose consent is off
 * is never in the list, and the list replaces what was held, so turning consent off ends it by the next sleep at the
 * latest; the boot that showed the switch had already let every hold go. One bot shared by two cards is handed once. */

// One connection as the hand-over reads it: its card's declaration and owning extension, when it has one.
export interface SleepWatchCard {
    readonly capability: Pick<Capability, "id" | "kind" | "config">;
    readonly declared?: { readonly watch: SleepWatchDeclaration; readonly extension: string };
}

export interface SleepWatchSources {
    readonly hosted: boolean;
    readonly cards: readonly SleepWatchCard[];
    // Provider to the extension that owns its listener.
    readonly owners: ReadonlyMap<string, string>;
    readonly automations: readonly Pick<AutomationRecord, "enabled" | "expiresAt" | "trigger">[];
    readonly now: number;
}

type ConfigValue = string | number | boolean | undefined;
const FilledSchema = z.string().min(1);
const configOf = (capability: SleepWatchCard["capability"]): Readonly<Record<string, ConfigValue>> => capability.config;

// The providers an enabled, unexpired listener automation listens on now.
const listenedProviders = (sources: SleepWatchSources): ReadonlySet<string> =>
    new Set(
        sources.automations.flatMap((automation) =>
            automation.enabled && (automation.expiresAt === undefined || automation.expiresAt > sources.now) && automation.trigger.kind === "listener"
                ? [automation.trigger.provider]
                : [],
        ),
    );

// The credential a consented, listened-to connection hands over, or undefined.
const handedOver = (card: SleepWatchCard, sources: SleepWatchSources, listened: ReadonlySet<string>): SleepWatch | undefined => {
    const { capability, declared } = card;
    if (capability.kind !== "cli" || declared === undefined) {
        return undefined;
    }
    const config = configOf(capability);
    const provider = FilledSchema.safeParse(config["provider"]).data;
    const credential = FilledSchema.safeParse(config[declared.watch.credential]).data;
    if (
        provider === undefined ||
        sources.owners.get(provider) !== declared.extension ||
        !listened.has(provider) ||
        !sleepWatchConsented(declared.watch, config) ||
        credential === undefined ||
        isVaulted(credential)
    ) {
        return undefined;
    }
    return { service: declared.watch.service, connection: capability.id, credential };
};

/** The connections to hand over at this sleep, at most the contract's SLEEP_WATCHES_MAX, none on a sandbox the platform
 * does not host. */
export const sleepWatchesOf = (sources: SleepWatchSources): SleepWatch[] => {
    if (!sources.hosted) {
        return [];
    }
    const listened = listenedProviders(sources);
    const byCredential = new Map<string, SleepWatch>();
    for (const card of sources.cards) {
        const watch = handedOver(card, sources, listened);
        if (watch !== undefined && !byCredential.has(watch.credential)) {
            byCredential.set(watch.credential, watch);
        }
    }
    return [...byCredential.values()].slice(0, SLEEP_WATCHES_MAX);
};

/** Hands the platform what it holds while this machine sleeps, in place of anything it held. Never rejects: a platform
 * that does not take them costs this sleep its watches, never the sleep. */
export const handOverSleepWatches = async (config: Config, logger: Pick<Logger, "info" | "warn">, watches: readonly SleepWatch[]): Promise<void> => {
    if (watches.length === 0) {
        return;
    }
    try {
        const answer = await callIngress(config, { route: "sleepWatch", input: { watches: [...watches] }, signal: AbortSignal.timeout(8_000) });
        if (answer.status !== 200) {
            logger.warn({ status: answer.status, refusal: answer.refusal }, "hosted sleep: the platform did not take the connections to hold; a mention while asleep is not heard");
            return;
        }
        logger.info({ asked: watches.length, held: answer.data?.held }, "hosted sleep: the platform holds the consented connections while this sandbox sleeps");
    } catch (error) {
        logger.warn({ err: error }, "hosted sleep: the connections to hold could not be handed over; a mention while asleep is not heard");
    }
};
