import { randomUUID } from "node:crypto";
import { codexContract, type OauthAccount } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { emailOf, pollDeviceAuth, startDeviceAuth } from "./codex-credentials.js";

// ChatGPT (Codex) OAuth — the sandbox owns the credential, stored in Codex's native auth.json (one dir per
// account) so the CLI refreshes it itself. `start` mints a device code + verification URL; `poll` reports
// pending until the user finishes signing in, then writes the tokens as a new account (labeled from the
// signed-in email when the user gave none); `accounts` lists them; `disconnect` clears the one named by id.
export const createCodexRoutes = (services: Services) => {
    const i = implement(codexContract).$context<OrpcContext>();
    // Fold the proactive health verdict onto an account row (helper, not an inline map spread).
    const withHealth = async (account: OauthAccount): Promise<OauthAccount> => {
        const health = await services.codexHealth(account.id);
        return health === undefined ? account : { ...account, ...health };
    };
    return {
        start: i.start.handler(() => startDeviceAuth()),
        poll: i.poll.handler(async ({ input }) => {
            const tokens = await pollDeviceAuth(input.deviceAuthId, input.userCode);
            if (tokens === undefined) {
                return { pending: true };
            }
            const id = randomUUID();
            const label = input.label?.trim() || emailOf(tokens.idToken) || "ChatGPT";
            await services.codexStore.write(id, label, tokens);
            return { pending: false, account: { id, label, connectedAt: Date.now() } };
        }),
        // Attach each account's proactive health so the UI can badge a revoked sign-in before the user chats.
        accounts: i.accounts.handler(async () => ({ accounts: await Promise.all((await services.codexStore.list()).map(withHealth)) })),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await services.codexStore.clear(input.id);
            return { ok: true } as const;
        }),
    };
};
