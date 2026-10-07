import { randomInt } from "node:crypto";
import { within } from "@intentic/base/async";
import type { AccountUsage, LoginStatus, OauthAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { forgetAccountState, sameAccount, signInIdentity } from "../../agent/providers/accounts/account-identity.js";
import { type ArmedCatch, armLoopbackCatch } from "../../agent/providers/accounts/loopback-bridge.js";
import {
    authorizeUrlFor,
    buildAuthorizeUrl,
    CLAUDE_LOOPBACK_PATH,
    CLAUDE_PASTE_REDIRECT,
    claudeLoopbackRedirect,
    exchangeCode,
    newAccount,
    parseClaudeGrant,
    reconnectAccount,
    renameAccount,
    toAccount,
} from "./claude-credentials.js";
import type { SeatRefusal } from "./claude-seats.js";

// Claude's account door (agent/provider-module.ts): subscription OAuth the sandbox owns, never the platform. Two ways
// back, one exchange: where a device or browser of the owner's watches loopback (loopback-bridge.ts), Anthropic sends
// the browser to http://localhost:<port>/callback, the landing is caught on that machine and finished here unasked,
// and the dead-end address is what a person pastes from anywhere else; where nothing watches, Anthropic's page shows
// code#state and the person pastes that. The PKCE verifier stays here, never on the wire.

// Merges in the usage window when measured; account objects from the store are not mutated in place.
const withUsage = (account: OauthAccount, usage: AccountUsage | undefined): OauthAccount => (usage === undefined ? account : { ...account, usage });

// The seat mark rides on the row as the fact it is; which of a revoked sign-in and a lost seat wins is the
// serviceability rule's to say (`serviceState`), once, in the `state` the account list publishes.
const withSeat = (account: OauthAccount, seat: SeatRefusal | undefined): OauthAccount =>
    seat === undefined ? account : { ...account, seatRefusal: seat.reason };

export type ClaudeAccountDeps = Pick<
    Services,
    | "accountUsage"
    | "claudeModels"
    | "claudeSeatCheck"
    | "claudeSeats"
    | "claudeStore"
    | "headroom"
    | "observedLimits"
    | "providerRefusals"
    | "hostHub"
    | "webextHub"
    | "logger"
>;

// How long list waits for a fresh plan-limit reading before falling back to what's on file.
const USAGE_WAIT_MS = 1_500;

// How long a forced read waits (longer: the caller is watching a spinner); bounded by READ_TIMEOUT_MS (8s).
const FORCED_USAGE_WAIT_MS = 9_000;

// How long a started attempt stays answerable; only bounds how long a forgotten attempt's verifier is kept.
const LOGIN_WINDOW_MS = 15 * 60_000;

// Where a loopback redirect lands: the ephemeral range, as Claude Code's own listener picks, so it rarely meets a port
// anything on the owner's machine already holds (and a catcher that does says `busy`, leaving the paste).
const LOOPBACK_PORTS = { from: 49_152, to: 65_535 } as const;

// How long an attempt's outcome stays readable once it left `pending`, for a card polling it to learn how it ended.
const OUTCOME_KEPT_MS = 15 * 60_000;

interface PendingAttempt {
    readonly verifier: string;
    readonly expiresAt: number;
    // The redirect this attempt's authorize URL named; the exchange names it again.
    readonly redirectUri: string;
    readonly caught: ArmedCatch;
    // Set while an exchange is in flight, so a paste and a caught landing never redeem one grant twice.
    finishing: boolean;
}

export const claudeAccountDoor = (services: ClaudeAccountDeps): AccountDoor => {
    const pending = new Map<string, PendingAttempt>();
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
    const drop = (handshake: string): void => {
        pending.get(handshake)?.caught.disarm();
        pending.delete(handshake);
    };
    // The one exchange, whether the grant was pasted or caught. A failed paste leaves the attempt open, since a mistyped
    // code deserves another go and the card says why right there; success closes it and stops every watch.
    const finish = async (handshake: string, grant: string, label: string): Promise<OauthAccount> => {
        const attempt = pending.get(handshake);
        if (attempt === undefined || attempt.expiresAt <= Date.now()) {
            throw new Error("That sign-in has expired or was never started here: start the connection again.");
        }
        const parsed = parseClaudeGrant(grant);
        if (parsed.error !== undefined) {
            throw new Error(parsed.error);
        }
        if (parsed.code === "") {
            throw new Error(
                attempt.redirectUri === CLAUDE_PASTE_REDIRECT
                    ? "Paste the code the sign-in page showed."
                    : "Paste the whole address the sign-in page sent your browser to.",
            );
        }
        // Checked against the attempt's own state, never a value the caller sent: a mismatch is another sign-in's grant.
        if (parsed.state !== "" && parsed.state !== handshake) {
            throw new Error("That belongs to a different sign-in: use the one this attempt opened.");
        }
        if (attempt.finishing) {
            throw new Error("This sign-in is already finishing.");
        }
        attempt.finishing = true;
        try {
            const tokens = await exchangeCode(grant, attempt.verifier, handshake, attempt.redirectUri);
            drop(handshake);
            // Reconnect and "add another" are the same sign-in; which one it was is decided by whose account came back
            // (the one connect rule, account-identity.ts): the same identity lands on the same id, so its row, usage
            // history and every chat or automation pinned to it carry on.
            const match = sameAccount(await services.claudeStore.list(), tokens);
            const stored = match === undefined ? undefined : await services.claudeStore.read(match.id);
            const account = stored === undefined ? newAccount(tokens, label) : reconnectAccount(stored, tokens, label);
            await services.claudeStore.write(account);
            // The model list cached before this sign-in was asked with no token (or another one), and holds for an
            // hour: a sandbox whose picker opened first went on showing the CLI's one versioned model after connecting.
            services.claudeModels.forget();
            const row = toAccount(account);
            settled(handshake, { status: "ok", account: row });
            return row;
        } finally {
            attempt.finishing = false;
        }
    };
    const forget = async (id: string): Promise<void> => {
        await Promise.all([services.claudeStore.clear(id), services.claudeSeats.clear(id), forgetAccountState(services, "claude", id)]);
        services.claudeModels.forget();
    };
    return {
        start: async () => {
            const now = Date.now();
            for (const [state, attempt] of pending) {
                if (attempt.expiresAt <= now) {
                    drop(state);
                }
            }
            const port = randomInt(LOOPBACK_PORTS.from, LOOPBACK_PORTS.to + 1);
            const loopback = buildAuthorizeUrl(claudeLoopbackRedirect(port));
            const { verifier, state } = loopback;
            const expiresAt = now + LOGIN_WINDOW_MS;
            // Armed before the attempt is recorded, and delivering into it by handshake: a landing cannot come back before
            // the page it lands from has even been handed out.
            const caught = armLoopbackCatch(
                services,
                { id: state, host: "localhost", port, path: CLAUDE_LOOPBACK_PATH, state, expiresAt, title: "Claude" },
                // Nobody is looking at a caught landing's refusal as it happens, so it ends the attempt with its reason on
                // `status`, where the card reads it, rather than leaving a spent grant behind an open attempt.
                async (url) => {
                    try {
                        await finish(state, url, "");
                    } catch (error) {
                        drop(state);
                        settled(state, { status: "error", error: error instanceof Error && error.message !== "" ? error.message : "Anthropic refused that sign-in." });
                        throw error;
                    }
                },
            );
            const watched = caught.catchers.length > 0;
            const redirectUri = watched ? loopback.redirectUri : CLAUDE_PASTE_REDIRECT;
            pending.set(state, { verifier, expiresAt, redirectUri, caught, finishing: false });
            return {
                url: watched ? loopback.authorizeUrl : authorizeUrlFor(loopback, CLAUDE_PASTE_REDIRECT),
                code: "",
                // A watched attempt dead-ends on a loopback address anywhere nobody watches, so what comes back by hand is
                // that address: a redirect, recognisable by this state, rather than the code Anthropic's page shows.
                state: watched ? state : "",
                flow: watched ? "redirect" : "paste",
                variant: "",
                handshake: state,
                expiresAt,
                catchers: [...caught.catchers],
            };
        },
        complete: async ({ handshake, code, redirectUrl, label }) => {
            const grant = redirectUrl?.trim() || code?.trim() || "";
            return await finish(handshake, grant, label ?? "");
        },
        status: (handshake) => {
            const attempt = pending.get(handshake);
            if (attempt !== undefined && attempt.expiresAt > Date.now()) {
                return { status: "wait" };
            }
            return outcomes.get(handshake)?.status ?? { status: "error", error: "That sign-in has expired or was never started here: start it again." };
        },
        cancel: (handshake) => {
            drop(handshake);
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
                // Waited for no longer than the reading; a recheck still running then lands on a later read.
                within(Promise.all(marked.map((id) => services.claudeSeatCheck.recheck(id, { force }))), withinMs, undefined),
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
