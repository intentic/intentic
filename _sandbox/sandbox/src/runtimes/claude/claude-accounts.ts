import type { AccountUsage, OauthAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { buildAuthorizeUrl, exchangeCode, newAccount, renameAccount, toAccount } from "./claude-credentials.js";
import type { SeatRefusal } from "./claude-seats.js";

/* CLAUDE'S ACCOUNT DOOR (agent/provider-module.ts): subscription OAuth the sandbox owns, the platform never
 * sees. Anthropic's is the one PASTE-BACK flow: the browser shows a code, the user brings it here, and the
 * exchange answers with the account at once. The PKCE verifier used to travel to the browser and back for that;
 * it is held HERE now, by the attempt's state, so nothing redeemable is on the wire at all and an attempt the
 * daemon restarted under is simply one to start again. */

// An account plus its usage window, when one has been measured. Kept out of the map callback so the account
// object is never mutated in place, the store hands back a fresh view per call, but it isn't ours to edit.
const withUsage = (account: OauthAccount, usage: AccountUsage | undefined): OauthAccount => (usage === undefined ? account : { ...account, usage });

/* And the row for an account whose organization has switched Claude Code off: the provider's own sentence, said
 * WITHOUT needsReauth. That is the whole distinction, reconnecting is the fix for a dead credential and the one
 * thing that cannot help here, since this account signs in perfectly and publishes headroom the entire time it
 * refuses every turn. Only an admin clears it, so the row says what happened rather than offering a button that
 * would spend a sign-in to arrive back where it started.
 *
 * A revoked credential outranks it: that one IS reconnectable, and it is the older problem of the two. */
const withSeat = (account: OauthAccount, seat: SeatRefusal | undefined): OauthAccount =>
    seat === undefined || account.needsReauth === true ? account : { ...account, detail: seat.reason };

export type ClaudeAccountDeps = Pick<Services, "accountUsage" | "claudeSeats" | "claudeStore" | "headroom">;

/* How long the account list will wait for a fresh plan-limit reading before answering with what is on file.
 *
 * It waits at all because the read is free, no tokens, one round-trip per account, and because a percentage
 * this list cannot back up is worth less than no percentage: these pools are account-wide, so a reading taken
 * at the end of the last turn describes an allowance that the desktop app, another Claude Code or claude.ai
 * itself may have spent since. Waiting is what makes this list say the same thing the provider's own usage
 * dialog says, which is the only standard it can be judged against.
 *
 * And it waits only THIS long because the list is also how the Agent tab learns which accounts exist at all. A
 * quota endpoint having a slow minute must cost the rings their freshness, never the page its connections, so
 * the sweep keeps running past the deadline and lands for the next read. */
const USAGE_WAIT_MS = 1_500;

/* And how long a FORCED read waits, which is longer for the one reason that changes the arithmetic: somebody is
 * watching a spinner they started. The deadline above is set so a page never pays for a slow quota endpoint;
 * here the read IS what was asked for, so giving up early would answer the question with the stale number the
 * press was doubting. Bounded by the read's own timeout (READ_TIMEOUT_MS, 8s), past that there is nothing left
 * to wait for. */
const FORCED_USAGE_WAIT_MS = 9_000;

// How long a started attempt stays answerable: Anthropic's own code lifetime is shorter, so this only bounds
// how long a forgotten attempt's verifier is kept.
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
        // Each account carries its plan-limit reading, so the picker can show what's left on each without
        // spending a turn on it, brought up to date first (see USAGE_WAIT_MS), because an account's allowance
        // moves whether or not this sandbox is the one spending it. Absent only for an account no reading has
        // ever been obtained for; the UI reads that as unknown, not as empty.
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
            // The row this replaces on the card carries the seat note, so this one has to as well: a rename is
            // not the moment to quietly drop the reason an account has been benched.
            return withSeat(toAccount(renamed), (await services.claudeSeats.read())[id]);
        },
        // Forget the credential AND everything filed against it: a reconnect mints a fresh account id, so a
        // snapshot or a seat refusal left behind here is orphaned for good.
        disconnect: async (id) => {
            await Promise.all([services.claudeStore.clear(id), services.headroom.clear("claude", id), services.claudeSeats.clear(id)]);
        },
    };
};
