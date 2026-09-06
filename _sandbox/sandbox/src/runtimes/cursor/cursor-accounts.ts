import type { Services } from "../../composition.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { composeEnvironment } from "../../environment/environment.js";
import { cancelCursorLogin, startCursorLogin, toAccount } from "./cursor-credentials.js";

/* CURSOR'S ACCOUNT DOOR (agent/provider-module.ts). Its PKCE verifier is redeemable on its own, so it never
 * leaves the daemon: `start` begins the flow, keeps the verifier in memory, polls Cursor until the browser
 * completes the sign-in, mints a 90-day user key and writes it as an account. From the caller's side that is a
 * device flow with nothing to type: open the page, then watch the account list. Cursor publishes no plan-wide
 * headroom, so `force` on the list has nothing to re-measure and answers at once. */

// The name this sandbox's key carries in Cursor's own dashboard API-keys list. It has to be recognisable
// there and it has to distinguish one sandbox from the owner's laptop, because revoking the right key is a
// thing people do at exactly the moment they cannot ask anyone which one it is.
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
        // A blank label CLEARS the override rather than storing an empty string, so the row falls back to the
        // sign-in identity instead of becoming nameless (displayLabel owns that ladder).
        const renamed = typed === "" ? { ...stored, label: undefined } : { ...stored, label: typed };
        await services.cursorStore.write(renamed);
        return toAccount(renamed);
    },
    // Recompose after the credential goes: on every published image that is what makes the SDK's bootstrap
    // follow the accounts it has.
    disconnect: async (id) => {
        await services.cursorStore.clear(id);
        await composeEnvironment(services);
    },
});
