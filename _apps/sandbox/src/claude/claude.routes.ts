import { type AccountUsage, claudeContract, type OauthAccount } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { buildAuthorizeUrl, exchangeCode, newAccount, renameAccount, toAccount } from "./claude-credentials.js";

// An account plus its usage window, when one has been measured. Kept out of the map callback so the account
// object is never mutated in place — the store hands back a fresh view per call, but it isn't ours to edit.
const withUsage = (account: OauthAccount, usage: AccountUsage | undefined): OauthAccount => (usage === undefined ? account : { ...account, usage });

// Claude subscription OAuth — the sandbox owns the credential, the platform never sees it. `start` hands the
// browser the authorize URL + PKCE material; `exchange` stores the tokens as a new account; `accounts` lists
// them; `rename` renames one; `disconnect` clears the one named by id. The agent route reads the account the
// turn selected.
export const createClaudeRoutes = (services: Services) => {
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
        // Each account carries its last known usage window, so the picker can show what's left on each without
        // spending a turn on it. Absent for an account that hasn't run a Claude turn since its window last
        // reset — the UI reads that as unknown, not as empty.
        accounts: i.accounts.handler(async () => {
            const [accounts, usage] = await Promise.all([services.claudeStore.list(), services.claudeUsage.read()]);
            return { accounts: accounts.map((account) => withUsage(account, usage[account.id])) };
        }),
        models: i.models.handler(() => services.claudeModels.models()),
        // Forget the credential AND its usage snapshot: a reconnect mints a fresh account id, so a snapshot left
        // behind here is orphaned for good.
        disconnect: i.disconnect.handler(async ({ input }) => {
            await Promise.all([services.claudeStore.clear(input.id), services.claudeUsage.clear(input.id)]);
            return { ok: true } as const;
        }),
    };
};
