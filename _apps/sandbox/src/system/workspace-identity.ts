import { randomUUID } from "node:crypto";
import type { Services } from "../composition.js";
import { statePath } from "../workspace/state-paths.js";

// The workspace's stable identity at <workspace>/.intentic/workspace.json, minted at the first boot of an
// empty /work and surviving with the volume. Streamed as the /events hello frame so the browser can tell a
// wiped-and-recreated workspace (same sandbox id after cleanup.sh + reconnect) from a surviving one and drop
// its persisted query cache. Missing/corrupt file → mint, same fallback as fileCapabilitiesStore.
// ponytail: two racing first connections may each mint an id; last write wins and the loser only costs one
// extra browser cache purge.
export const workspaceIdentity = async (services: Services): Promise<string> => {
    const path = statePath(services.workspace.root, ".intentic/workspace.json");
    const raw = await services.files.read(path);
    if (raw !== undefined) {
        try {
            const id: unknown = (JSON.parse(raw) as { id?: unknown }).id;
            if (typeof id === "string" && id.length > 0) {
                return id;
            }
        } catch {
            // corrupt file — fall through to mint
        }
    }
    const id = randomUUID();
    await services.files.write(path, `${JSON.stringify({ id }, undefined, 2)}\n`);
    return id;
};
