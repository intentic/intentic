import { methods, type NewSessionResponse, RequestError } from "@agentclientprotocol/sdk/unstable";
import { sessionModelsOf, sessionThoughtsOf, thoughtTiers } from "@intentic/acp-events/model";
import type { Model } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { z } from "zod";
import type { HarnessConnection } from "./connection.js";
import { needsSignIn } from "./turn.js";

// WHAT A HARNESS SAYS OF ITSELF BEFORE ANY TURN: whether it is signed in, as whom, and which models and thinking levels
// it offers. Read from the harness, never assumed: the models are its own list for its own login, and the sign-in is
// its own stored one, which this package neither holds nor reads off disk.

export type SignedIn = `yes` | `no` | `unknown`;

export interface HarnessFacts {
    readonly signedIn: SignedIn;
    // Who it is signed in as, where the harness says.
    readonly account?: { readonly label?: string | undefined; readonly email?: string | undefined; readonly organization?: string | undefined } | undefined;
    // Its models in its own order, and the one a fresh conversation starts on. Empty when it keeps its model to itself.
    readonly models: readonly Model[];
    readonly defaultModel: string | undefined;
}

// The auth/status answer an agent that advertises `auth.status` gives (an ACP proposal Claude Code's adapter serves).
const AuthStatusSchema = z.object({
    state: z.string(),
    accounts: z
        .array(z.looseObject({ label: z.string().optional(), email: z.string().optional(), organization: z.string().optional() }))
        .optional()
        .catch(undefined),
});

const AdvertisesStatusSchema = z.object({ auth: z.looseObject({ status: z.looseObject({}) }) });

// The agent's own word on its sign-in, where it has one to give without opening a session.
const statedSignIn = async (connection: HarnessConnection): Promise<Pick<HarnessFacts, `signedIn` | `account`> | undefined> => {
    if (!AdvertisesStatusSchema.safeParse(connection.capabilities).success) {
        return undefined;
    }
    // allow(silent-catch): an agent that advertises the method and refuses it has said nothing of its sign-in, which is what undefined reads as below
    const answered = AuthStatusSchema.safeParse(await connection.agent.request(`auth/status`, {}).catch(() => undefined));
    if (!answered.success) {
        return undefined;
    }
    const { state, accounts } = answered.data;
    if (state === `authenticated`) {
        return { signedIn: `yes`, account: accounts?.[0] };
    }
    return state === `unauthenticated` ? { signedIn: `no` } : undefined;
};

/** Asks a running harness for its facts, opening one session in `cwd` to read its models and letting it go again. */
export const readHarnessFacts = async (connection: HarnessConnection, cwd: string): Promise<HarnessFacts> => {
    const stated = await statedSignIn(connection);
    let opened: NewSessionResponse;
    try {
        opened = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
    } catch (error) {
        // A harness that opens no session until it is signed in says so here; any other refusal says nothing of it.
        const refused = error instanceof RequestError && needsSignIn(error);
        return { signedIn: refused ? `no` : (stated?.signedIn ?? `unknown`), account: stated?.account, models: [], defaultModel: undefined };
    }
    const session = opened.sessionId;
    const models = sessionModelsOf(opened.configOptions);
    const thoughts = sessionThoughtsOf(opened.configOptions);
    const efforts = thoughts === undefined ? [] : thoughtTiers(thoughts);
    const facts: HarnessFacts = {
        // A session that opened is the only evidence an agent without a status method gives.
        signedIn: stated?.signedIn ?? `yes`,
        account: stated?.account,
        models: (models?.choices ?? []).map((choice): Model => {
            const model: Model = { id: choice.value, label: choice.name };
            if (choice.description !== undefined) {
                model.description = choice.description;
            }
            if (efforts.length > 0) {
                model.efforts = efforts;
            }
            return model;
        }),
        defaultModel: models?.current,
    };
    if (connection.capabilities.sessionCapabilities?.close != null) {
        // allow(silent-catch): a session that would not close costs the harness an idle session, nothing a reader sees.
        void connection.agent.request(methods.agent.session.close, { sessionId: session }).catch(() => undefined);
    }
    return facts;
};
