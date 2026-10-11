import type { Services } from "../../../composition.js";
import { forgetAccountState, sameAccount, signInIdentity } from "../../../agent/providers/accounts/account-identity.js";
import type { AccountDoor } from "../../../agent/providers/provider-module.js";
import { devinAgentId, ensureDevinCli } from "../devin-cli.js";
import { toAccount } from "./devin-credentials.js";
import { cancelDevinLogin, redeemDevinLogin, startDevinLogin } from "./devin-login.js";

// Devin's account door (agent/provider-module.ts): start installs the CLI if this sandbox has none yet (the sign-in is
// the CLI's own) and hands the card its page as a paste flow; complete types the page's code into that CLI and keeps
// the key it hands back. Devin publishes no allowance a key can read, so a row carries no usage.

// What the door reads: the account store, the overlay it recomposes (the pack follows an account onto disk), the ACP
// pool a forgotten account's process is ended in, the catalog a new first account changes, and the stores a forgotten
// account is cleared from.
export type DevinAccountDeps = Pick<
    Services,
    "acpConnections" | "composeEnvironment" | "devinModels" | "devinStore" | "headroom" | "observedLimits" | "providerRefusals"
>;

export const devinAccountDoor = (services: DevinAccountDeps): AccountDoor => ({
    start: async () => {
        const binary = await ensureDevinCli();
        const started = await startDevinLogin(binary);
        return { url: started.url, code: "", state: "", flow: "paste", variant: "", handshake: started.handshake, expiresAt: started.expiresAt };
    },
    complete: async ({ handshake, code, label }) => {
        const redeemed = await redeemDevinLogin(handshake, code ?? "");
        // The one connect rule (account-identity.ts): the same person signing in again lands on their account's id and
        // keeps its name and place, so every conversation pinned to it carries on; anyone else is new.
        const match = sameAccount(await services.devinStore.list(), redeemed.email !== undefined ? { email: redeemed.email } : {});
        const kept = match === undefined ? undefined : await services.devinStore.read(match.id);
        const typed = label?.trim() ?? "";
        const stored = {
            id: kept?.id ?? handshake,
            ...(typed !== "" ? { label: typed } : kept?.label !== undefined ? { label: kept.label } : {}),
            ...(redeemed.email !== undefined ? { email: redeemed.email } : {}),
            ...(redeemed.plan !== undefined ? { plan: redeemed.plan } : {}),
            apiKey: redeemed.apiKey,
            connectedAt: kept?.connectedAt ?? Date.now(),
        };
        await services.devinStore.write(stored);
        services.devinModels.forget();
        await services.composeEnvironment();
        services.devinStore.logger.info({ account: stored.id, reconnected: kept !== undefined }, "devin: account connected");
        return toAccount(stored);
    },
    cancel: cancelDevinLogin,
    list: async () => services.devinStore.list(),
    rename: async (id, label) => {
        const stored = await services.devinStore.read(id);
        if (stored === undefined) {
            return undefined;
        }
        const typed = label.trim();
        // A blank label clears the override, not an empty string, so the row falls back to displayLabel's identity.
        const renamed = typed === "" ? { ...stored, label: undefined } : { ...stored, label: typed };
        await services.devinStore.write(renamed);
        return toAccount(renamed);
    },
    identityOf: signInIdentity,
    // Clears the key and everything read about it, ends the account's warm process (it holds the key), and recomposes,
    // so the pack leaves the overlay with the last account.
    forget: async (id) => {
        services.acpConnections.drop(devinAgentId(id));
        await Promise.all([services.devinStore.clear(id), forgetAccountState(services, "devin", id)]);
        services.devinModels.forget();
        await services.composeEnvironment();
    },
});
