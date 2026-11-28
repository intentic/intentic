import type { ListenerStrangers } from "@intentic/extension-manifest";
import type { WakeSource } from "@intentic/sandbox-contract/schemas/command-admission";
import type { Trigger } from "@intentic/sandbox-contract/schemas/automations";
import { cachedEnabledExtensions } from "../../capabilities/contributions.js";
import type { ExtensionHost } from "../../capabilities/extension-inventory/installed-extensions.js";
import { listenerOwnership } from "../../extensions/listener/listener-state.js";
import { wakeSourceOf } from "../../guard/actions.js";
import { CORE_TRIGGER_SOURCES } from "../catalog.js";

// WHICH ADMISSION FLOOR A WAKE ANSWERS TO, read off what its source declares (2026-11-26). A listener source anyone on the
// internet reaches says so (`strangers` on the core's own sources and on an extension's `contributes.listener`), and its
// wakes are held to the owner's floor for that kind of stranger instead of the team chat's. The core's own sources answer
// first, as in the catalogue, so no extension can relabel them (of them only `s2s` is reached by strangers since the
// Visitor chat moved out, a sandbox that is not a contact asking to become one, 2026-11-27); then the extension that owns
// the provider's listener (listener-state.ts), the one whose gateway or doors actually fire it: the issues extension's
// bug reports and the visitor-chat extension's chats since 2026-11-26.

/** What the provider's source declares about strangers, or undefined for a source only the owner's people reach. */
export const strangersOf = async (services: ExtensionHost, provider: string): Promise<ListenerStrangers | undefined> => {
    const core = CORE_TRIGGER_SOURCES.find((source) => source.provider === provider);
    if (core !== undefined) {
        return core.strangers;
    }
    const owner = (await listenerOwnership(services)).owners.get(provider);
    if (owner === undefined) {
        return undefined;
    }
    return (await cachedEnabledExtensions(services)).find((extension) => extension.id === owner)?.manifest.contributes?.listener?.strangers;
};

/** The admission policy's key a wake of `trigger` is held to. */
export const wakeSourceFor = async (services: ExtensionHost, trigger: Trigger): Promise<WakeSource> =>
    wakeSourceOf(trigger, trigger.kind === "listener" ? await strangersOf(services, trigger.provider) : undefined);
