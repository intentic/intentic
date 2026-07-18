import type { ExtensionModule } from "@intentic/extension-api";
import { extensionApiVersion, extensionIdOf } from "@intentic/extension-api";
import { type ExtensionSummary, ExtensionsListSchema } from "@intentic/sandbox-contract";
import { shallowRef } from "vue";
import { extensionSettingsStore } from "../composables/extensions/useExtensionSettings";
import { sandboxError, sandboxJson, sandboxRequest } from "../composables/sandbox/sandboxClient";
import { errorMessage } from "../composables/useAsyncAction";
import { createExtensionApi, type HostBindings } from "./apiImpl";
import { satisfiesEngines } from "./engines";

/* Loads and activates installed third-party extensions: GET /extensions → per extension, engines check →
 * authenticated bundle fetch → Blob URL → import() → activate(api, context). The Blob detour exists because a
 * bare import() of a daemon URL can't carry the Bearer header — which also forces single-file ESM bundles
 * (relative chunk imports break under a blob: base). Every failure is contained to its extension and recorded
 * on a status the Sandbox hub's Extensions tab renders; the shell never crashes on a bad bundle. */

export interface ExtensionHostStatus {
    // The capability entry id (the daemon's handle) and the manifest-derived identity (publisher.name).
    readonly id: string;
    readonly extensionId: string;
    readonly state: "active" | "agent-only" | "incompatible" | "error";
    readonly detail?: string | undefined;
}

export const extensionStatuses = shallowRef<readonly ExtensionHostStatus[]>([]);

const loadOne = async (summary: ExtensionSummary, host: HostBindings): Promise<ExtensionHostStatus> => {
    const extensionId = extensionIdOf(summary.manifest);
    if (!satisfiesEngines(summary.manifest.engines.intentic, extensionApiVersion)) {
        return {
            id: summary.id,
            extensionId,
            state: `incompatible`,
            detail: `needs intentic ${summary.manifest.engines.intentic}; this app provides ${extensionApiVersion}`,
        };
    }
    if (summary.manifest.entry === undefined) {
        return { id: summary.id, extensionId, state: `agent-only` };
    }
    try {
        // Settings load BEFORE activation so api.settings.get is synchronous from the first activate() line.
        await extensionSettingsStore(summary.id).load();
        const response = await sandboxRequest(`/extensions/${encodeURIComponent(summary.id)}/bundle`);
        if (!response.ok) {
            throw await sandboxError(response);
        }
        const url = URL.createObjectURL(new Blob([await response.text()], { type: `text/javascript` }));
        try {
            const module = (await import(/* @vite-ignore */ url)) as Partial<ExtensionModule> & { default?: ExtensionModule };
            const resolved = module.default ?? module;
            if (typeof resolved.activate !== `function`) {
                throw new Error(`the bundle exports no activate(api, context)`);
            }
            const { api, context } = createExtensionApi(summary, host);
            await resolved.activate(api, context);
            return { id: summary.id, extensionId, state: `active` };
        } finally {
            URL.revokeObjectURL(url);
        }
    } catch (error) {
        return { id: summary.id, extensionId, state: `error`, detail: errorMessage(error, String(error)) };
    }
};

export const loadExtensions = async (host: HostBindings): Promise<void> => {
    const { extensions } = ExtensionsListSchema.parse(await sandboxJson(`/extensions`));
    extensionStatuses.value = await Promise.all(extensions.map((summary) => loadOne(summary, host)));
};
