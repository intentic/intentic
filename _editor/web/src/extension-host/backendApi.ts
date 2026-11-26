import type { IntenticApi } from "@intentic/extension-api";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { sandboxJson, sandboxRequest } from "../client/sandbox/sandboxClient";
import type { ProcedureOutput } from "../client/sandbox/sandboxRpc";
import { rpcKey } from "../lib/queryKeys";
import { queryClient } from "../lib/queryPersistence";

// The host resolves paths into this extension's own namespace. The daemon's installed manifest says whether it has a
// server, asked at each read rather than once at activation: an open view keeps the api it was set up with, and a daemon
// rebuilt under it is the one whose answer counts. 2026-11-26: a page opened on a daemon from before the Pipelines
// backend kept sending Fix to the `/ci/fix` the rebuilt daemon had dropped, and every press came back 404.

// This extension's entry in the newest list this page holds, when that list was read after the activation: what the
// daemon says now. The list refetches on every hello and is reset by a rebuild (systemEvents.ts); one hydrated from a
// previous visit is older than the activation, so it never outvotes the list the activation was made from.
const listedSince = (id: string, activatedAt: number): ExtensionSummary | undefined => {
    const state = queryClient.getQueryState<ProcedureOutput<`extensions.list`>>(rpcKey(`extensions.list`));
    return state?.data === undefined || state.dataUpdatedAt <= activatedAt ? undefined : state.data.extensions.find((entry) => entry.id === id);
};

export const extensionBackendApi = (backendPath: (path: string) => string, summary: ExtensionSummary, fromInventory: boolean): IntenticApi["backend"] => {
    const activatedAt = Date.now();
    return {
        // Unknown only while no list has named the extension: a compiled-in one the daemon's list left out.
        get available() {
            const listed = listedSince(summary.id, activatedAt) ?? (fromInventory ? summary : undefined);
            return listed === undefined ? undefined : listed.manifest.server !== undefined;
        },
        request: (path, init) => sandboxRequest(backendPath(path), init),
        json: (path, init) => sandboxJson(backendPath(path), init),
    };
};
