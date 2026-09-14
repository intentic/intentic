import type { WebExtConfig } from "@intentic/sandbox-contract";
import { peerHandler } from "./peer.handler.js";
import { WEBEXT_TOOLS_NOTE } from "../../webext/webext-skills.js";

/* A BROWSER OF THE USER'S OWN, reached through the extension they installed in it: the peer handler (peers/) over the webext door. */
export const webextHandler = peerHandler<WebExtConfig>({
    kind: "webext",
    noun: "browser",
    where: "in that browser",
    note: WEBEXT_TOOLS_NOTE,
    pairHint: "click Connect and paste the code into the extension",
    awayHint: "that browser is closed",
    added: (id) => `Added "${id}". Install the extension in that browser and paste the code its card is offering; the agent can work in it from the next turn.`,
    store: (ctx) => ctx.webexts,
    hub: (ctx) => ctx.webextHub,
    echo: (browser) => ({
        platform: browser.platform,
        read: browser.read,
        act: browser.act,
        screenshot: browser.screenshot,
        cookies: browser.cookies,
        confirm: browser.confirm,
    }),
});
