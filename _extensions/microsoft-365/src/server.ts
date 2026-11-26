import { join } from "node:path";
import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { storeRefreshTokenAsExtension } from "@intentic/connector-runtime";
import type { ExtensionServerApi, ExtensionServerModule, ServerActivation } from "@intentic/extension-api";
import { type Account, accountOf } from "./accounts.js";
import { actionFor, executeAction, heldStore, type Outward, performHeld } from "./actions.js";
import type { Http } from "./auth.js";
import { Graph } from "./graph.js";
import { createSessions } from "./sessions.js";
import { createSignIns } from "./sign-in.js";
import { cardTools } from "./tools.js";

// THE BACKEND THAT HOLDS THE CARD'S SIGN-IN (2026-11-26). Every `m365` command runs here, in the extension's own
// backend, handed the card's settings (its refresh token and client secret included) with each call by the daemon's
// tool door, never anywhere the agent's shell can read them. `m365` reaches it through the turn's shell door
// (`POST /tools/<card>`, which the daemon opens only to a turn that mounted this card), sending the workspace files a
// command reads and saving what comes back (tools.ts). What it sends, books or uploads is decided by the owner's action
// rules in the daemon (actions.ts), and an approved one is carried out here through `api.approvals.perform` once the
// daemon has matched and spent a person's yes. Before, the refresh token sat in every turn's environment and `m365`
// read the rules and the approval's status from workspace files the agent writes.

export interface ServerOptions {
    // Microsoft's sign-in and Graph; the platform's fetch unless a suite stands in for both.
    readonly http?: Http;
    readonly pause?: (ms: number) => Promise<void>;
}

const statusOf = (error: Error): number | undefined => ("status" in error && Number.isInteger(error.status) ? Number(error.status) : undefined);

// The daemon's outward-action door, through the backend's typed client. A row that could not be written costs the row,
// never an action that already went out.
const outwardOf = (api: ExtensionServerApi): Outward => ({
    ask: (call) => api.daemon.rpc.capabilities.outwardAction(call),
    outcome: async (call) => {
        await api.daemon.rpc.capabilities.outwardActionOutcome(call).catch((error: Error) => {
            api.log(`an Activity row for ${call.action} on "${call.id}" was not recorded: ${errorMessage(error)}`);
        });
    },
});

// The card as the daemon holds it now: undefined once it is gone.
const cardNow =
    (api: ExtensionServerApi) =>
    async (id: string): Promise<Account | undefined> => {
        try {
            const connection = await api.daemon.rpc.capabilities.connection({ id });
            return accountOf(connection.id, connection.config);
        } catch (error) {
            if (error instanceof Error && statusOf(error) === 404) {
                return undefined;
            }
            throw error;
        }
    };

export const createServer =
    (options: ServerOptions = {}): ExtensionServerModule["activateServer"] =>
    (api: ExtensionServerApi): ServerActivation => {
        const http = options.http ?? fetch;
        let stopped = false;
        const store = (write: Parameters<typeof storeRefreshTokenAsExtension>[1]) => storeRefreshTokenAsExtension(api, write);
        const sessions = createSessions(store, http);
        const graphFor = (account: Account): Graph => new Graph(account, sessions.tokenFor(account), http);
        const held = heldStore(join(api.stateDir, "held"));
        const outward = outwardOf(api);
        const card = cardNow(api);
        const signIns = createSignIns({
            store,
            current: async (id) => (await card(id))?.refreshToken,
            http,
            pause: async (ms) => {
                if (stopped) {
                    throw new Error("The connection's backend was reloaded while waiting for the sign-in: sign in again");
                }
                await (options.pause ?? sleep)(ms);
            },
        });
        const tools = cardTools({
            graphFor,
            actFor: (graph, account, conversationId) => (draft) => executeAction({ graph, outward, held, conversationId }, actionFor(account, draft)),
            signIns,
        });
        api.tools.serve((served) => (served === undefined ? [] : tools(served)));
        api.approvals.perform((approved) => performHeld({ outward, held, account: card, graphFor }, approved.digest));
        return {
            deactivate: () => {
                stopped = true;
                sessions.clear();
            },
        };
    };

export const activateServer = createServer();
