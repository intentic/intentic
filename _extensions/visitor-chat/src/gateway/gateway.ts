import { runConnectorGateway } from "@intentic/connector-runtime";
import { daemonChats, WEBCHAT_PROVIDER } from "../server/chats.js";
import { workspaceOutbox } from "../server/outbox.js";
import { deliverToOutbox } from "./deliver.js";

// THE GATEWAY (2026-11-26): what the daemon delivers to a visitor after their stream closed, as it delivers to any
// channel's gateway (`/deliver`): a wake held for a person and let, a person writing as the agent, a held wake's
// decline. A visitor has no connection to post to, so a reply goes into the outbox their widget polls (outbox.ts),
// where the daemon put it itself until then. The connector runtime's shell holds the rest: the reply's id posted once
// (a retry of the same reply is answered as delivered), the status the daemon reads, and the loopback door. It holds
// no provider connection and needs no card: the daemon starts it while a Visitor chat automation is on.

await runConnectorGateway<{ readonly provider: string }, never>({
    provider: WEBCHAT_PROVIDER,
    create: ({ api, workspaceRoot }) => ({
        desired: () => [],
        keyOf: () => WEBCHAT_PROVIDER,
        open: () => Promise.reject(new Error(`a Visitor chat holds no connection`)),
        close: () => undefined,
        deliver: deliverToOutbox(workspaceOutbox(workspaceRoot), daemonChats(() => api.daemon.rpc.automations.list())),
    }),
});
