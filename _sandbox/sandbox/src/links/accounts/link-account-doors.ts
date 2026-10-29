import { type AgentProvider, AgentProviderSchema,DEFAULT_PROVIDER } from "@intentic/sandbox-contract/schemas/agent";
import {
    type RunnerCredential,
    RunnerCredentialRefreshRequestSchema,
    RunnerCredentialRequestSchema,
} from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { type AccountCopy, isBorrowedId, SharedAccountRefSchema, type SharedAccountRef } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import type { Context } from "hono";
import type { Logger } from "pino";
import type { z } from "zod";
import { opt } from "../../opt.js";
import type { AppEnv } from "../../app-env.js";
import type { ResolvedLink } from "../inbound-links.js";
import { type HeldAccount, linkAccountsOf, namedHeld } from "./held-accounts.js";

// AN ACCOUNTS LINK'S DOORS, the lending side (schemas/providers/account-sharing.ts). Each starts from the link the
// request presents and answers only for an account its terms name and this sandbox may still share that way
// (held-accounts.ts `namedHeld`): anything else reads as no such account, as an unknown task does. The shapes are the
// runner credential doors' own (sandboxes/credential-lending.ts), so a borrowed turn is resolved by the rule that resolves
// a runner's: an access token minted for it, never the refresh token behind it.

export interface LinkAccountDoorDeps {
    readonly logger: Logger;
    // Every account held here, with how it may be shared; read per call, since a sign-in can be revoked any minute.
    readonly held: () => Promise<readonly HeldAccount[]>;
    readonly copyOf: (ref: SharedAccountRef) => Promise<AccountCopy | undefined>;
    // One turn's credential, resolved the way this sandbox's own turns resolve it and stripped to what may travel.
    readonly credential: (input: { readonly agent: AgentProvider; readonly account?: string; readonly model?: string }) => Promise<RunnerCredential>;
    // A fresh access token in place of the one a provider refused, or undefined when the sign-in cannot be renewed.
    readonly remint: (account: string, rejected: string) => Promise<string | undefined>;
}

const NOT_LENT = "This link does not lend that account. Its owner can bring it in again from the other sandbox's Models page.";

// The request body read through its schema; a body that is not JSON reads as none, which the schema refuses.
const parsedBody = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T | undefined> => {
    // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses.
    const raw: unknown = await c.req.json().catch(() => undefined);
    const parsed = schema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : undefined;
};

// Which ref a credential request names: a provider shared whole (a translator's) carries no account.
const refOf = (agent: AgentProvider, account: string | undefined): SharedAccountRef => (account === undefined ? { provider: agent } : { provider: agent, account });

export const createLinkAccountDoors = (deps: LinkAccountDoorDeps) => ({
    /** GET /link/accounts */
    accounts: async (c: Context<AppEnv>, link: ResolvedLink): Promise<Response> =>
        c.json({ accounts: linkAccountsOf(await deps.held(), link.terms.accounts) }),

    /** POST /link/accounts/copy */
    copy: async (c: Context<AppEnv>, link: ResolvedLink): Promise<Response> => {
        const ref = await parsedBody(c, SharedAccountRefSchema);
        if (ref === undefined) {
            return c.json({ error: "Name the account: a provider, and the account where the provider holds several." }, 400);
        }
        const found = namedHeld(await deps.held(), link.terms.accounts, ref);
        const copy = found?.mode === "copy" ? await deps.copyOf(ref) : undefined;
        if (copy === undefined) {
            return c.json({ error: NOT_LENT }, 404);
        }
        deps.logger.info({ link: link.id, provider: ref.provider, account: ref.account }, "link: static account copied to a linked sandbox");
        return c.json({ copy });
    },

    /** POST /link/credentials */
    credential: async (c: Context<AppEnv>, link: ResolvedLink): Promise<Response> => {
        const body = await parsedBody(c, RunnerCredentialRequestSchema);
        if (body === undefined) {
            return c.json({ error: "invalid request" }, 400);
        }
        const agent = AgentProviderSchema.safeParse(body.agent ?? DEFAULT_PROVIDER);
        if (!agent.success) {
            return c.json({ ok: false, message: `this sandbox does not know the provider "${body.agent ?? ""}": update it.` } satisfies RunnerCredential);
        }
        const found = namedHeld(await deps.held(), link.terms.accounts, refOf(agent.data, body.account));
        if (found?.mode !== "lend" || (body.account !== undefined && isBorrowedId(body.account))) {
            return c.json({ error: NOT_LENT }, 404);
        }
        const answer = await deps.credential({
            agent: agent.data,
            ...opt("account", body.account),
            ...opt("model", body.model),
        });
        deps.logger.info({ link: link.id, agent: agent.data, account: body.account, ok: answer.ok }, "link: credential lent for a linked sandbox's turn");
        return c.json(answer);
    },

    /** POST /link/credentials/refresh */
    refresh: async (c: Context<AppEnv>, link: ResolvedLink): Promise<Response> => {
        const body = await parsedBody(c, RunnerCredentialRefreshRequestSchema);
        if (body === undefined) {
            return c.json({ error: "invalid request" }, 400);
        }
        const found = namedHeld(await deps.held(), link.terms.accounts, { provider: "claude", account: body.account });
        if (found?.mode !== "lend") {
            return c.json({ error: NOT_LENT }, 404);
        }
        const accessToken = await deps.remint(body.account, body.rejected).catch((error: Error) => {
            deps.logger.warn({ err: error, link: link.id, account: body.account }, "link: mid-turn re-mint for a linked sandbox failed");
            return undefined;
        });
        return c.json(accessToken === undefined ? {} : { accessToken });
    },

});

export type LinkAccountDoors = ReturnType<typeof createLinkAccountDoors>;
