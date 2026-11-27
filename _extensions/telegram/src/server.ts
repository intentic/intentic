import { createDaemonClient, createLog } from "@intentic/connector-runtime";
import type { ExtensionServerApi, ServerActivation } from "@intentic/extension-api/runtime";
import { judgeWakeCall, SECRET_TOKEN_HEADER, WAKE_ROUTE, type WakeCall } from "./wake.js";

// The Telegram card's backend (2026-11-27): the wake door Telegram is pointed at while a sandbox the platform hosts sleeps
// (wake.ts). It dispatches nothing. A delivery that reached the door while the machine slept was answered 503 by the
// platform's edge and woke it; the gateway's first poll after the wake takes the update from Telegram's queue. So a
// delivery that reaches this backend before the gateway has deleted the webhook is refused too, and Telegram keeps the
// update and tries again.

const log = createLog("telegram");

// How soon Telegram may try again; by then the gateway has usually taken the bot back.
const RETRY_AFTER_S = 10;

const answers = {
    ours: () => new Response("this sandbox polls for its updates", { status: 503, headers: { "retry-after": String(RETRY_AFTER_S) } }),
    // Refused, not acknowledged: a webhook set under a token since replaced is still this sandbox's bot, whose update the
    // gateway's poll takes once it clears that webhook.
    wrong: () => new Response("wrong secret token", { status: 403 }),
    // Telegram runs a method named in a webhook's answer for the bot it delivered for. No card here holds the bot any more
    // (removed after its webhook was set, before a start could clear it), so the bot stops calling this door rather than
    // waking the sandbox for nobody. The update in hand is let go with it.
    gone: () => Response.json({ method: "deleteWebhook" }),
    stranger: () => new Response("not a Telegram delivery", { status: 401 }),
} satisfies Record<WakeCall, () => Response>;

// The connected cards' bot tokens, read from the daemon's feed for this extension's own listener (which hands it only the
// cards it contributes) at the moment of the call, so a card changed since the webhook was set is judged as it is now.
const botTokens = async (api: ExtensionServerApi): Promise<readonly string[]> => {
    const { connectors } = await createDaemonClient<{ readonly botToken?: string }>("telegram", api.daemon, log).state();
    return connectors.map(({ config }) => config.botToken ?? "").filter((token) => token !== "");
};

export const activateServer = (api: ExtensionServerApi): ServerActivation => {
    api.publicRoutes.serve(async (request, verified) => {
        if (verified.route !== WAKE_ROUTE) {
            return undefined;
        }
        const tokens = await botTokens(api).catch((error: Error) => {
            log.warn({ err: error }, "telegram: the wake door could not read the bots it serves; Telegram tries again");
            return undefined;
        });
        if (tokens === undefined) {
            return new Response("try again", { status: 503, headers: { "retry-after": String(RETRY_AFTER_S) } });
        }
        const call = judgeWakeCall(request.headers.get(SECRET_TOKEN_HEADER), tokens);
        if (call === "gone" || call === "wrong") {
            log.info({ call }, `telegram: the wake door heard from a bot ${call === "gone" ? "no card here holds; it is told to stop" : "under a secret its token did not make"}`);
        }
        return answers[call]();
    });
    return { deactivate: () => undefined };
};
