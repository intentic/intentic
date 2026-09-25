import type { Services } from "../../composition.js";
import { forgetAccountState, signInIdentity } from "../../agent/providers/accounts/account-identity.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { cancelCursorLogin, startCursorLogin, toAccount } from "./cursor-credentials.js";

// Cursor's account door (agent/provider-module.ts): start begins a device-style flow, keeps the PKCE verifier in memory
// (never leaves the daemon), polls until sign-in completes, then mints a 90-day user key. `list` carries each row's
// reading, which for Cursor is what it has refused (cursor-usage.ts) rather than anything it publishes — the one thing
// that tells two Cursor accounts apart in a picker.

// Name shown in Cursor's own dashboard API-keys list; must distinguish this sandbox from the owner's laptop so revoking
// the right key doesn't require guessing.
const keyName = (): string => `intentic sandbox (${process.env["INTENTIC_WORKSPACE_NAME"] ?? "workspace"})`;

// What the door reads: the account store, the headroom it refreshes a list against, the overlay it recomposes, and the
// stores a forgotten account is cleared from.
export type CursorAccountDeps = Pick<
    Services,
    "accountUsage" | "composeEnvironment" | "cursorStore" | "headroom" | "observedLimits" | "providerRefusals"
>;

export const cursorAccountDoor = (services: CursorAccountDeps): AccountDoor => ({
    start: async () => {
        const started = await startCursorLogin({ store: services.cursorStore, keyName: keyName(), connected: () => services.composeEnvironment() });
        return { url: started.url, code: "", state: "", flow: "device", variant: "", handshake: started.handshake, expiresAt: started.expiresAt };
    },
    cancel: cancelCursorLogin,
    // Swept first, since a ledger entry ages out on its own: the sweep is what takes a spent reading back, and without
    // it a row that has since reopened would keep its ring until the next refusal somewhere else.
    list: async (force) => {
        await services.headroom.refresh({ scope: { providers: ["cursor"] }, ...(force ? { maxAgeMs: 0, watched: true } : {}) });
        const [accounts, usage] = await Promise.all([services.cursorStore.list(), services.accountUsage.read()]);
        return accounts.map((account) => {
            const reading = usage[account.id];
            return reading === undefined ? account : { ...account, usage: reading };
        });
    },
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
    identityOf: signInIdentity,
    // Clears the credential and everything read about it (its refusal ledger is what Cursor's rings are), then recomposes:
    // what makes the SDK bootstrap follow current accounts on a published image.
    forget: async (id) => {
        await Promise.all([services.cursorStore.clear(id), forgetAccountState(services, "cursor", id)]);
        await services.composeEnvironment();
    },
});
