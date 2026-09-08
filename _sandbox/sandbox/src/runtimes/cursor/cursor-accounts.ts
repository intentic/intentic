import type { Services } from "../../composition.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { composeEnvironment } from "../../environment/environment.js";
import { cancelCursorLogin, startCursorLogin, toAccount } from "./cursor-credentials.js";

// Cursor's account door (agent/provider-module.ts): start begins a device-style flow, keeps the PKCE verifier in memory
// (never leaves the daemon), polls until sign-in completes, then mints a 90-day user key. `force` on `list` answers at
// once: Cursor publishes no plan-wide headroom to re-measure.

// Name shown in Cursor's own dashboard API-keys list; must distinguish this sandbox from the owner's laptop so revoking
// the right key doesn't require guessing.
const keyName = (): string => `intentic sandbox (${process.env["INTENTIC_WORKSPACE_NAME"] ?? "workspace"})`;

export const cursorAccountDoor = (services: Services): AccountDoor => ({
    start: async () => {
        const started = await startCursorLogin({ store: services.cursorStore, keyName: keyName(), connected: () => composeEnvironment(services) });
        return { url: started.url, code: "", state: "", flow: "device", variant: "", handshake: started.handshake, expiresAt: started.expiresAt };
    },
    cancel: cancelCursorLogin,
    list: async () => await services.cursorStore.list(),
    rename: async (id, label) => {
        const stored = await services.cursorStore.read(id);
        if (stored === undefined) {
            return undefined;
        }
        const typed = label.trim();
        // A blank label clears the override, not an empty string, so the row falls back to displayLabel's identity.
        const renamed = typed === "" ? { ...stored, label: undefined } : { ...stored, label: typed };
        await services.cursorStore.write(renamed);
        return toAccount(renamed);
    },
    // Recomposes after the credential is gone: what makes the SDK bootstrap follow current accounts on a published
    // image.
    disconnect: async (id) => {
        await services.cursorStore.clear(id);
        await composeEnvironment(services);
    },
});
