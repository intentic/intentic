import { errorMessage } from "@intentic/base/errors";
import type { SleepWatch } from "@intentic/api-contract/ingress";
import type { ExtensionSleepHeard } from "@intentic/sandbox-contract/extension-protocol";
import { contributionFor, contributionRegistry } from "../../capabilities/contributions.js";
import type { ExtensionHost } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";
import { callIngress } from "../../system/platform-client.js";
import { type SleepWatchCard, sleepWatchesOf } from "../../system/sleep/sleep-watches.js";
import { listenerOwnership } from "../listener/listener-state.js";

/* THE CARDS BEHIND A HOSTED SLEEP'S ONE HANDED-OVER CREDENTIAL (2026-11-27), read where the connections live: which of
 * this sandbox's cards declare `sleepWatch`, for the hand-over before a sleep (system/sleep/sleep-watches.ts decides
 * which of them go), and what the platform heard for one extension's own such cards while the sandbox slept.
 *
 * What was heard: for each connection whose bot the platform held, it kept where the messages addressed to the bot are
 * (ids, never words). An extension asks for its own connections' at its gateway's start (`api.sleep.heard()`, POST
 * /extension/sleep/heard), and fetches each message itself to answer it as if it had just arrived. The platform hands
 * them over once and forgets them, and the asking ends whatever it still held. Only the asking extension's own cards are
 * asked for, so one extension never learns where another's messages are. */

/** The connections this sandbox would hand over now, read from its cards, their declarations and its automations. */
export const consentedSleepWatches = async (services: Pick<Services, "automations" | "capabilities"> & ExtensionHost, hosted: boolean): Promise<SleepWatch[]> => {
    if (!hosted) {
        return [];
    }
    const [capabilities, registry, ownership, automations] = await Promise.all([
        services.capabilities.list(),
        contributionRegistry(services),
        listenerOwnership(services),
        services.automations.list(),
    ]);
    const cards = capabilities.map((capability): SleepWatchCard => {
        const resolved = capability.kind === "cli" ? contributionFor(registry, "cli", capability.config) : undefined;
        const watch = resolved?.spec.kind === "cli" ? resolved.spec.sleepWatch : undefined;
        return watch === undefined || resolved === undefined ? { capability } : { capability, declared: { watch, extension: resolved.extension.id } };
    });
    return sleepWatchesOf({ hosted, cards, owners: ownership.owners, automations, now: Date.now() });
};

const NOTHING: ExtensionSleepHeard = { heard: [] };

/** The caller's connections' references, or why the platform could not say; nothing on a sandbox it does not host. */
export const sleepHeardFor = async (
    services: Pick<Services, "config" | "capabilities" | "logger"> & ExtensionHost,
    extensionId: string,
): Promise<ExtensionSleepHeard | { readonly error: string }> => {
    if (!services.config.sandbox.vm) {
        return NOTHING;
    }
    const [capabilities, registry] = await Promise.all([services.capabilities.list(), contributionRegistry(services)]);
    const connections = capabilities.flatMap((capability) => {
        const resolved = capability.kind === "cli" ? contributionFor(registry, "cli", capability.config) : undefined;
        return resolved?.extension.id === extensionId && resolved.spec.kind === "cli" && resolved.spec.sleepWatch !== undefined ? [capability.id] : [];
    });
    if (connections.length === 0) {
        return NOTHING;
    }
    try {
        const answer = await callIngress(services.config, { route: "sleepHeard", input: { connections }, signal: AbortSignal.timeout(10_000) });
        if (answer.status !== 200 || answer.data === undefined) {
            return { error: answer.refusal ?? `the platform answered HTTP ${String(answer.status)}` };
        }
        if (answer.data.heard.length > 0) {
            services.logger.info({ extension: extensionId, heard: answer.data.heard.length }, "hosted sleep: handing over what the platform heard while this sandbox slept");
        }
        return { heard: answer.data.heard };
    } catch (error) {
        return { error: `the platform could not be asked: ${errorMessage(error)}` };
    }
};
