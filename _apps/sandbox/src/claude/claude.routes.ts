import { type AccountUsage, claudeContract, type OauthAccount } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { buildAuthorizeUrl, exchangeCode, newAccount, renameAccount, toAccount } from "./claude-credentials.js";

// An account plus its usage window, when one has been measured. Kept out of the map callback so the account
// object is never mutated in place — the store hands back a fresh view per call, but it isn't ours to edit.
const withUsage = (account: OauthAccount, usage: AccountUsage | undefined): OauthAccount => (usage === undefined ? account : { ...account, usage });

export type ClaudeRoutesDeps = Pick<Services, "accountUsage" | "claudeModels" | "claudeStore" | "claudeUsage">;

/* How long the account list will wait for a fresh plan-limit reading before answering with what is on file.
 *
 * It waits at all because the read is free — no tokens, one round-trip per account — and because a percentage
 * this list cannot back up is worth less than no percentage: these pools are account-wide, so a reading taken
 * at the end of the last turn describes an allowance that the desktop app, another Claude Code or claude.ai
 * itself may have spent since. Waiting is what makes this list say the same thing the provider's own usage
 * dialog says, which is the only standard it can be judged against.
 *
 * And it waits only THIS long because the list is also how the Agent tab learns which accounts exist at all. A
 * quota endpoint having a slow minute must cost the rings their freshness, never the page its connections — so
 * the sweep keeps running past the deadline and lands for the next read. */
const USAGE_WAIT_MS = 1_500;

// Claude subscription OAuth — the sandbox owns the credential, the platform never sees it. `start` hands the
// browser the authorize URL + PKCE material; `exchange` stores the tokens as a new account; `accounts` lists
// them; `rename` renames one; `disconnect` clears the one named by id. The agent route reads the account the
// turn selected.
export const createClaudeRoutes = (services: ClaudeRoutesDeps) => {
    const i = implement(claudeContract).$context<OrpcContext>();
    return {
        start: i.start.handler(() => buildAuthorizeUrl()),
        exchange: i.exchange.handler(async ({ input }) => {
            const account = newAccount(await exchangeCode(input.code, input.verifier, input.state), input.label ?? "");
            await services.claudeStore.write(account);
            return toAccount(account);
        }),
        // Rename the account named by id. A 404 rather than a silent no-op: renaming a row that another device
        // just disconnected must tell the card its list is stale, not pretend the write landed.
        rename: i.rename.handler(async ({ input }) => {
            const stored = await services.claudeStore.read(input.id);
            if (stored === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "That Claude account is no longer connected." });
            }
            const renamed = renameAccount(stored, input.label);
            await services.claudeStore.write(renamed);
            return toAccount(renamed);
        }),
        // Each account carries its plan-limit reading, so the picker can show what's left on each without
        // spending a turn on it — brought up to date first (see USAGE_WAIT_MS), because an account's allowance
        // moves whether or not this sandbox is the one spending it. Absent only for an account no reading has
        // ever been obtained for; the UI reads that as unknown, not as empty.
        accounts: i.accounts.handler(async () => {
            await services.claudeUsage.refresh(USAGE_WAIT_MS);
            const [accounts, usage] = await Promise.all([services.claudeStore.list(), services.accountUsage.read()]);
            return { accounts: accounts.map((account) => withUsage(account, usage[account.id])) };
        }),
        models: i.models.handler(() => services.claudeModels.models()),
        // Forget the credential AND its usage snapshot: a reconnect mints a fresh account id, so a snapshot left
        // behind here is orphaned for good.
        disconnect: i.disconnect.handler(async ({ input }) => {
            await Promise.all([services.claudeStore.clear(input.id), services.accountUsage.clear(input.id)]);
            return { ok: true } as const;
        }),
    };
};
