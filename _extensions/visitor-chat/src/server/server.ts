import { randomUUID } from "node:crypto";
import type { ExtensionServerApi, ServerActivation } from "@intentic/extension-api";
import { LISTENER_DISPATCH_KEY_HEADER } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { daemonChats, WEBCHAT_PROVIDER } from "./chats.js";
import { doorRoutes } from "./door.js";
import { daemonVerifier } from "./identity.js";
import { fileInstallsStore } from "./installs.js";
import { workspaceOutbox } from "./outbox.js";
import { documentThreads, type ThreadsFile, ThreadsFileSchema } from "./threads.js";
import { verifyTurnstile } from "./turnstile.js";

// THE BACKEND (2026-11-26): the Visitor chat, which the daemon ran itself until then (its webchat/ module). It runs only
// while this extension is on, and the daemon keeps nothing of the feature but the doors every extension gets:
// - the public door (`contributes.publicRoutes`): the widget's script, a chat's settings, a visitor's message with the
//   answer streamed back, and the poll for later answers, behind the daemon's protections (door.ts);
// - the listener door, which wakes a chat's automation through this extension's `webchat` source, held to the owner's
//   floor for a website visitor (wake.ts), and the identity door beside it, which says who a signed-in visitor is;
// - /x/intentic.visitor-chat for the install panel: which sites loaded a chat's widget.
// The gateway process (src/gateway) writes the answers a visitor's stream did not carry into the outbox this reads.

// The install panel's one read: `installs/<chat id>`.
export const INSTALLS_ROUTE = `installs`;

export const activateServer = (api: ExtensionServerApi): ServerActivation => {
    const now = Date.now;
    const installs = fileInstallsStore(api.workspaceRoot, api.log);
    const threads = api.document<ThreadsFile>(`threads.json`, {
        parse: (raw) => ThreadsFileSchema.safeParse(raw).data,
        fallback: () => ({}),
        granularity: `record`,
    });

    api.publicRoutes.serve(
        doorRoutes({
            chats: daemonChats(() => api.daemon.rpc.automations.list(), now),
            threads: documentThreads(threads),
            outbox: workspaceOutbox(api.workspaceRoot),
            installs,
            verifyIdToken: daemonVerifier((path, init) => api.daemon.request(path, init), api.log),
            verifyTurnstile,
            // Named by the message's own id, so a retry of the same request is admitted once.
            dispatch: (message) =>
                api.daemon.request(`/listeners/${WEBCHAT_PROVIDER}/dispatch?stream=1`, {
                    method: `POST`,
                    headers: { "content-type": `application/json`, [LISTENER_DISPATCH_KEY_HEADER]: message.id || randomUUID() },
                    body: JSON.stringify(message),
                }),
            log: api.log,
            now,
            extensionDir: api.extensionDir,
        }),
    );

    api.routes.mount(async (request) => {
        const [, head, id, more] = new URL(request.url).pathname.split(`/`);
        if (request.method !== `GET` || head !== INSTALLS_ROUTE || id === undefined || id === `` || more !== undefined) {
            return undefined;
        }
        return Response.json({ origins: await installs.list(decodeURIComponent(id)) });
    });

    return {
        deactivate: () => installs.flush(),
    };
};
