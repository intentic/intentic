import type { AccountUsage, OauthAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { forgetAccountState, sameAccount, signInIdentity } from "../../agent/providers/accounts/account-identity.js";
import { buildAuthorizeUrl, exchangeCode, newAccount, reconnectAccount, renameAccount, toAccount } from "./claude-credentials.js";
import type { SeatRefusal } from "./claude-seats.js";

// Claude's account door (agent/provider-module.ts): subscription OAuth the sandbox owns, never the platform.
// Anthropic's flow is paste-back: browser shows a code, user brings it here, exchange returns the account. The PKCE
// verifier stays here, never on the wire.

// Merges in the usage window when measured; account objects from the store are not mutated in place.
const withUsage = (account: OauthAccount, usage: AccountUsage | undefined): OauthAccount => (usage === undefined ? account : { ...account, usage });

// The seat mark rides on the row as the fact it is; which of a revoked sign-in and a lost seat wins is the
// serviceability rule's to say (`serviceState`), once, in the `state` the account list publishes.
const withSeat = (account: OauthAccount, seat: SeatRefusal | undefined): OauthAccount =>
    seat === undefined ? account : { ...account, seatRefusal: seat.reason };

export type ClaudeAccountDeps = Pick<
    Services,
    "accountUsage" | "claudeSeatCheck" | "claudeSeats" | "claudeStore" | "headroom" | "observedLimits" | "providerRefusals"
>;

// How long list waits for a fresh plan-limit reading before falling back to what's on file.
const USAGE_WAIT_MS = 1_500;

// How long a forced read waits (longer: the caller is watching a spinner); bounded by READ_TIMEOUT_MS (8s).
const FORCED_USAGE_WAIT_MS = 9_000;

// Waits for `work` no longer than `ms`; what is still running after that lands on a later read.
const within = async (work: Promise<unknown>, ms: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
};

// How long a started attempt stays answerable; only bounds how long a forgotten attempt's verifier is kept.
const LOGIN_WINDOW_MS = 15 * 60_000;

export const claudeAccountDoor = (services: ClaudeAccountDeps): AccountDoor => {
    const pending = new Map<string, { readonly verifier: string; readonly expiresAt: number }>();
    const forget = async (id: string): Promise<void> => {
        await Promise.all([services.claudeStore.clear(id), services.claudeSeats.clear(id), forgetAccountState(services, "claude", id)]);
    };
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
            const tokens = await exchangeCode(code, attempt.verifier, handshake);
            pending.delete(handshake);
            // Reconnect and "add another" are the same sign-in; which one it was is decided by whose account came back
            // (the one connect rule, account-identity.ts): the same identity lands on the same id, so its row, usage
            // history and every chat or automation pinned to it carry on.
            const match = sameAccount(await services.claudeStore.list(), tokens);
            const stored = match === undefined ? undefined : await services.claudeStore.read(match.id);
            const account = stored === undefined ? newAccount(tokens, label ?? "") : reconnectAccount(stored, tokens, label ?? "");
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
            const withinMs = force ? FORCED_USAGE_WAIT_MS : USAGE_WAIT_MS;
            // A seat-marked account is re-tested too (claude-seat-check.ts), on its schedule, or at once when forced, so
            // the row shows access that came back without a turn having to run there.
            const marked = Object.keys(await services.claudeSeats.read());
            await Promise.all([
                services.headroom.refresh({
                    scope: { providers: ["claude"] },
                    // Forced is a person pressing re-measure and watching the age, the one caller allowed past the
                    // endpoint's own read budget.
                    ...(force ? { maxAgeMs: 0, watched: true } : {}),
                    withinMs,
                }),
                within(Promise.all(marked.map((id) => services.claudeSeatCheck.recheck(id, { force }))), withinMs),
            ]);
            // A duplicate left from before reconnects landed in place is the boot merge's (account-identity.ts), which
            // moves its pins to the survivor first; reading a list never deletes anything.
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
        identityOf: signInIdentity,
        // Clears the credential, usage, observed ledger, refusals and seat state together, so nothing is left to orphan.
        forget,
    };
};
