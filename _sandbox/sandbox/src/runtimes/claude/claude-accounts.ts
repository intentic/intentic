import type { AccountUsage, OauthAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { buildAuthorizeUrl, exchangeCode, newAccount, renameAccount, toAccount } from "./claude-credentials.js";
import type { SeatRefusal } from "./claude-seats.js";

// Claude's account door (agent/provider-module.ts): subscription OAuth the sandbox owns, never the platform.
// Anthropic's flow is paste-back: browser shows a code, user brings it here, exchange returns the account. The PKCE
// verifier stays here, never on the wire.

// Merges in the usage window when measured; account objects from the store are not mutated in place.
const withUsage = (account: OauthAccount, usage: AccountUsage | undefined): OauthAccount => (usage === undefined ? account : { ...account, usage });

// Row for an account an org has switched off: shows the provider's own sentence without needsReauth, since reconnecting
// can't fix it. A revoked credential still outranks this, since that one is reconnectable.
const withSeat = (account: OauthAccount, seat: SeatRefusal | undefined): OauthAccount =>
    seat === undefined || account.needsReauth === true ? account : { ...account, detail: seat.reason };

export type ClaudeAccountDeps = Pick<Services, "accountUsage" | "claudeSeats" | "claudeStore" | "headroom">;

// How long list waits for a fresh plan-limit reading before falling back to what's on file.
const USAGE_WAIT_MS = 1_500;

// How long a forced read waits (longer: the caller is watching a spinner); bounded by READ_TIMEOUT_MS (8s).
const FORCED_USAGE_WAIT_MS = 9_000;

// How long a started attempt stays answerable; only bounds how long a forgotten attempt's verifier is kept.
const LOGIN_WINDOW_MS = 15 * 60_000;

export const claudeAccountDoor = (services: ClaudeAccountDeps): AccountDoor => {
    const pending = new Map<string, { readonly verifier: string; readonly expiresAt: number }>();
    return {
        start: async () => {
            const now = Date.now();
            for (const [state, attempt] of pending) {
                if (attempt.expiresAt <= now) {
                    pending.delete(state);
                }
            }
            const { authorizeUrl, verifier, state } = buildAuthorizeUrl();
            const expiresAt = now + LOGIN_WINDOW_MS;
            pending.set(state, { verifier, expiresAt });
            return { url: authorizeUrl, code: "", state: "", flow: "paste", variant: "", handshake: state, expiresAt };
        },
        complete: async ({ handshake, code, label }) => {
            const attempt = pending.get(handshake);
            if (attempt === undefined || attempt.expiresAt <= Date.now()) {
                throw new Error("That sign-in has expired or was never started here: start the connection again.");
            }
            if (code === undefined || code.trim() === "") {
                throw new Error("Paste the code the sign-in page showed.");
            }
            const account = newAccount(await exchangeCode(code, attempt.verifier, handshake), label ?? "");
            pending.delete(handshake);
            await services.claudeStore.write(account);
            return toAccount(account);
        },
        cancel: (handshake) => {
            pending.delete(handshake);
        },
        // Refreshes plan-limit usage before listing (see USAGE_WAIT_MS), since an account's allowance can move outside
        // this sandbox. Usage is absent only when no reading has ever been obtained; the UI reads that as unknown, not
        // empty.
        list: async (force) => {
            await services.headroom.refresh({
                scope: { providers: ["claude"] },
                ...(force ? { maxAgeMs: 0 } : {}),
                withinMs: force ? FORCED_USAGE_WAIT_MS : USAGE_WAIT_MS,
            });
            const [accounts, usage, seats] = await Promise.all([services.claudeStore.list(), services.accountUsage.read(), services.claudeSeats.read()]);
            return accounts.map((account) => withUsage(withSeat(account, seats[account.id]), usage[account.id]));
        },
        rename: async (id, label) => {
            const stored = await services.claudeStore.read(id);
            if (stored === undefined) {
                return undefined;
            }
            const renamed = renameAccount(stored, label);
            await services.claudeStore.write(renamed);
            // Rename must carry the seat note too; it replaces the whole row on the card.
            return withSeat(toAccount(renamed), (await services.claudeSeats.read())[id]);
        },
        // Clears the credential, usage, and seat state; a reconnect mints a new id, so anything left behind orphans.
        disconnect: async (id) => {
            await Promise.all([services.claudeStore.clear(id), services.headroom.clear("claude", id), services.claudeSeats.clear(id)]);
        },
    };
};
