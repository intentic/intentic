import type { LoginStatus, OauthAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import { forgetAccountState, sameAccount, signInIdentity } from "../../../agent/providers/accounts/account-identity.js";
import { type ArmedCatch, armLoopbackCatch, loopbackWatchers } from "../../../agent/providers/accounts/loopback-bridge.js";
import type { AccountDoor } from "../../../agent/providers/provider-module.js";
import { devinAgentId, ensureDevinCli } from "../devin-cli.js";
import { toAccount } from "./devin-credentials.js";
import { cancelDevinLogin, devinLoginOpen, finishDevinLogin, startDevinLogin } from "./devin-login.js";

// Devin's account door (agent/provider-module.ts): start installs the CLI if this sandbox has none yet (the sign-in is
// the CLI's own) and starts its sign-in. Two ways back, as Claude's and Google's: where a device or browser of the
// owner's watches loopback (loopback-bridge.ts), Devin's page sends the browser to the CLI's 127.0.0.1 callback, the
// landing is caught on that machine and finished here unasked, and the dead-end address is what a person pastes from
// anywhere else; where nothing watches, Devin's page shows a code and the person pastes that. Devin publishes no
// allowance a key can read, so a row carries no usage.

// How long an attempt's outcome stays readable once it ended, for a card polling it to learn how it ended.
const OUTCOME_KEPT_MS = 15 * 60_000;

// What the door reads: the account store, the overlay it recomposes (the pack follows an account onto disk), the ACP
// pool a forgotten account's process is ended in, the catalog a new first account changes, the stores a forgotten
// account is cleared from, and the owner's devices and browsers that can catch a loopback landing.
export type DevinAccountDeps = Pick<
    Services,
    | "acpConnections"
    | "composeEnvironment"
    | "devinModels"
    | "devinStore"
    | "headroom"
    | "observedLimits"
    | "providerRefusals"
    | "hostHub"
    | "webextHub"
    | "logger"
>;

export const devinAccountDoor = (services: DevinAccountDeps): AccountDoor => {
    const caught = new Map<string, ArmedCatch>();
    const outcomes = new Map<string, { readonly status: LoginStatus; readonly at: number }>();
    const settled = (handshake: string, status: LoginStatus): void => {
        const now = Date.now();
        for (const [id, outcome] of outcomes) {
            if (now - outcome.at > OUTCOME_KEPT_MS) {
                outcomes.delete(id);
            }
        }
        outcomes.set(handshake, { status, at: now });
    };
    const disarm = (handshake: string): void => {
        caught.get(handshake)?.disarm();
        caught.delete(handshake);
    };
    // The one ending, whether the code or landing was pasted or the landing was caught.
    const finish = async (handshake: string, grant: string, label: string): Promise<OauthAccount> => {
        const redeemed = await finishDevinLogin(handshake, grant);
        disarm(handshake);
        // The one connect rule (account-identity.ts): the same person signing in again lands on their account's id and
        // keeps its name and place, so every conversation pinned to it carries on; anyone else is new.
        const match = sameAccount(await services.devinStore.list(), redeemed.email !== undefined ? { email: redeemed.email } : {});
        const kept = match === undefined ? undefined : await services.devinStore.read(match.id);
        const typed = label.trim();
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
        const row = toAccount(stored);
        settled(handshake, { status: "ok", account: row });
        return row;
    };
    return {
        start: async () => {
            const binary = await ensureDevinCli();
            // Asked before the CLI starts, since which sign-in it runs is the CLI's own choice once started.
            const watched = loopbackWatchers(services).length > 0;
            const started = await startDevinLogin(binary, watched ? "browser" : "manual");
            const base = { url: started.url, code: "", variant: "", handshake: started.handshake, expiresAt: started.expiresAt };
            if (started.landing === undefined) {
                return { ...base, state: "", flow: "paste" };
            }
            const { handshake } = started;
            const armed = armLoopbackCatch(
                services,
                { id: handshake, ...started.landing, expiresAt: started.expiresAt, title: "Devin" },
                // Nobody is looking at a caught landing's refusal as it happens, so it ends the attempt with its reason on
                // `status`, where the card reads it.
                async (url) => {
                    try {
                        await finish(handshake, url, "");
                    } catch (error) {
                        disarm(handshake);
                        settled(handshake, {
                            status: "error",
                            error: error instanceof Error && error.message !== "" ? error.message : "Devin refused that sign-in.",
                        });
                        throw error;
                    }
                },
            );
            caught.set(handshake, armed);
            // A watcher that left between the question and the watch leaves a paste of the dead-end address, which works.
            return { ...base, state: started.landing.state, flow: "redirect", catchers: [...armed.catchers] };
        },
        complete: async ({ handshake, code, redirectUrl, label }) => finish(handshake, redirectUrl?.trim() || code?.trim() || "", label ?? ""),
        status: (handshake) => {
            if (devinLoginOpen(handshake)) {
                return { status: "wait" };
            }
            return (
                outcomes.get(handshake)?.status ?? { status: "error", error: "That sign-in has expired or was never started here: start it again." }
            );
        },
        cancel: (handshake) => {
            disarm(handshake);
            cancelDevinLogin(handshake);
        },
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
    };
};
