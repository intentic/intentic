import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { readGatewayUrl } from "@intentic/connector-runtime";
import type { ExtensionServerApi, ServerActivation } from "@intentic/extension-api";
import { createAppLink, EVENTS_ROUTE, slackAppManifest } from "./app-manifest.js";
import { challengeOf, FORWARDED_HEADERS, GATEWAY_EVENTS_PATH } from "./http.js";
import { isHostedSandbox } from "./mode.js";

// THE BACKEND (2026-11-27): Slack's Request URL. A sandbox the platform hosts sleeps when nobody uses it, and a Socket
// Mode connection sleeps with it, so its Slack app POSTs events and button presses to the `events` public route
// (`contributes.publicRoutes`, `wakes: true`) instead; a call there while the sandbox sleeps is answered 503 by the edge
// and wakes it, and Slack's retry lands here. Only a backend hears a public route, while the connection, the card's
// signing secret and everything that answers live in the gateway process, so this hands each call on to the gateway's
// loopback unread (http.ts checks it there) and answers what the gateway answers. It also writes, on such a sandbox,
// the links its setup needs (SETUP_FILE), where the Slack skill tells the agent to look.

// Where the agent finds this sandbox's Slack setup, under the extension's state directory: the Request URL, and the link
// that creates an app already pointed at it.
export const SETUP_FILE = "app-setup.json";

// Longer than the gateway takes to answer (http.ts HTTP_ACK_MS) and inside Slack's three seconds.
const FORWARD_TIMEOUT_MS = 2_800;

// Slack retries a delivery that failed: at once, after a minute and after five.
const RETRY_AFTER_S = "60";

// Nothing could take the call: a gateway not running yet (the machine just woke, or no Slack card exists) or not
// answering. A `url_verification` is answered anyway, since it only echoes the caller's challenge and comes while an app
// is being created, before any card holds it; anything else is refused so Slack sends it again.
const unreachable = (contentType: string | null, body: string): Response => {
    const challenge = challengeOf(contentType ?? undefined, body);
    return challenge === undefined
        ? new Response("the Slack gateway is starting", { status: 503, headers: { "retry-after": RETRY_AFTER_S } })
        : new Response(challenge, { headers: { "content-type": "text/plain; charset=utf-8" } });
};

// What the backend reaches, each the real one when absent.
export interface SlackBackendDeps {
    // The gateway's loopback address, or undefined while it has published none.
    readonly gatewayUrl?: () => Promise<string | undefined>;
    // How a call reaches the gateway's loopback.
    readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
    // Whether this sandbox is one the platform hosts (mode.ts).
    readonly hosted?: boolean;
}

// The setup a hosted sandbox's Slack app needs, written where the agent reads it: nothing on any other sandbox, whose app
// keeps Socket Mode and the card's own link.
const writeSetup = async (api: ExtensionServerApi): Promise<void> => {
    const requestUrl = await api.sleep.wakeUrl(EVENTS_ROUTE);
    await mkdir(api.stateDir, { recursive: true });
    await writeFile(join(api.stateDir, SETUP_FILE), `${JSON.stringify({ requestUrl, createApp: createAppLink(slackAppManifest(requestUrl)) }, null, 4)}\n`);
};

// The host activates it with the api alone; a test hands in what it reaches instead.
export const activateServer = (api: ExtensionServerApi, deps: SlackBackendDeps = {}): ServerActivation => {
    const gatewayUrl = deps.gatewayUrl ?? (() => readGatewayUrl("slack", { INTENTIC_WORKSPACE: api.workspaceRoot }, api.workspaceRoot));
    const send = deps.fetch ?? fetch;

    api.publicRoutes.serve(async (request, verified) => {
        if (verified.route !== EVENTS_ROUTE) {
            return undefined;
        }
        const body = await request.text();
        const headers = new Headers();
        for (const name of FORWARDED_HEADERS) {
            const value = request.headers.get(name);
            if (value !== null) {
                headers.set(name, value);
            }
        }
        const contentType = request.headers.get("content-type");
        const gateway = await gatewayUrl().catch((error: Error) => {
            api.log(`slack: the gateway's address could not be read: ${error.message}`);
            return undefined;
        });
        if (gateway === undefined) {
            return unreachable(contentType, body);
        }
        try {
            const answered = await send(`${gateway}${GATEWAY_EVENTS_PATH}`, { method: "POST", headers, body, signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS) });
            // The gateway's 503 is a connection still opening: Slack is told when to send it again.
            const retry = answered.status === 503 ? { "retry-after": RETRY_AFTER_S } : undefined;
            return new Response(await answered.text(), { status: answered.status, headers: { "content-type": "text/plain; charset=utf-8", ...retry } });
        } catch (error) {
            api.log(`slack: handing a call to the gateway failed: ${errorMessage(error)}`);
            return unreachable(contentType, body);
        }
    });

    if (deps.hosted ?? isHostedSandbox()) {
        writeSetup(api).catch((error: Error) => api.log(`slack: this sandbox's Slack app link could not be written: ${error.message}`));
    }
    // Nothing to release: a call holds nothing past its answer. Declared so a change to this extension reloads it alone.
    return { deactivate: () => undefined };
};
