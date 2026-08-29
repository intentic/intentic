// webext: the user's own browser (the `webext` capability's live half)
import { z } from "zod";
/* ONE SITE THE PERSON ALLOWED, as the browser itself understands it. `origin` is Chrome's own match pattern
 * for that grant ("https://github.com/*"), because that is the string the extension asked `chrome.permissions`
 * for and the string the browser will show in its own settings — inventing a prettier spelling here would mean
 * a card naming something the browser's permission list does not.
 *
 * `mode` is this extension's own narrowing on top of Chrome's grant: a site may be readable without being
 * driveable. Chrome has no concept for that, so it is enforced in the extension and shown here so the card can
 * say which is which. */
export const WebExtGrantSchema = z.object({
    origin: z.string(),
    mode: z.enum(["read", "act"]),
});
export type WebExtGrant = z.infer<typeof WebExtGrantSchema>;
// What a connected browser reports about itself. The parallel of HostFacts, and the same job: the SKILL pack
// teaches the agent how to drive a browser, this tells it which browser, how many tabs are open, and — the
// part with no equivalent on a machine — exactly which sites it may touch right now.
export const WebExtFactsSchema = z.object({
    // How a person would name it: "Chrome 141 on Windows".
    browser: z.string(),
    // Tabs open right now. A count rather than a list: the list is a tool call away and changes every minute,
    // and a card that renders someone's open tabs is a card nobody wants to screenshot.
    tabs: z.number(),
    /* The sites the person has allowed, live from the browser's own permission store rather than from anything
     * this daemon remembers. It is the answer to the question every reader of this card actually has, and the
     * only honest source for it is the browser: a grant can be revoked in Chrome's UI without the sandbox
     * being told. */
    grants: z.array(WebExtGrantSchema),
    // The extension's own kill switch, flipped in its popup. True ⇒ every tool refuses, and says so.
    paused: z.boolean(),
});
export type WebExtFacts = z.infer<typeof WebExtFactsSchema>;
export const WebExtSummarySchema = z.object({
    // The capability id, the browser's name, and the prefix of its tools (mcp__<id>__click).
    id: z.string(),
    platform: z.string().min(1),
    online: z.boolean(),
    // The extension build, so a browser running an old one is visible rather than mysteriously lacking a tool.
    version: z.string().optional(),
    // Epoch ms of the last time this browser held a socket. Absent ⇒ it has not connected since this daemon
    // booted: liveness is a fact about a socket, so a restart forgets it rather than claiming stale uptime.
    lastSeen: z.number().optional(),
    facts: WebExtFactsSchema.optional(),
});
export type WebExtSummary = z.infer<typeof WebExtSummarySchema>;
export const WebExtsListSchema = z.object({ browsers: z.array(WebExtSummarySchema) });
/* ---- handing a site's session to the sandbox: what the extension POSTs, and what comes back ----
 *
 * THE PAYLOAD IS A CREDENTIAL, the whole of one. It travels on its own HTTPS door (webext-protocol.ts's
 * webextSessionUrl) rather than as an answer on the socket, because socket answers are MCP results and MCP
 * results land in the model's context. Nothing here is ever logged, echoed in an error, or written anywhere
 * but the target profile's cookie store. */
export const WebExtCookieSchema = z.object({
    name: z.string(),
    value: z.string(),
    // Chrome's own spelling, leading dot and all (".github.com"): it is what the browser stored, and rewriting
    // it here is how a session arrives that the target site does not recognise.
    domain: z.string(),
    path: z.string(),
    // Epoch SECONDS, Chrome's unit. Absent ⇒ a session cookie, which dies with the browser that receives it.
    expires: z.number().optional(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(["Strict", "Lax", "None"]),
});
export type WebExtCookie = z.infer<typeof WebExtCookieSchema>;
export const WebExtSessionImportSchema = z.object({
    // The `browser`-kind capability whose profile receives this. Named by the agent from the roster it can
    // already read, so a session can only ever land in an account the owner had already created.
    account: z.string().min(1),
    // The site this came from, for the message the owner reads afterwards. Never used to place the cookies:
    // each cookie carries its own domain.
    origin: z.string().min(1),
    // A ceiling rather than a guess: a big site's cookie jar for one registrable domain runs to dozens, and
    // anything past this is a caller that misunderstood the tool, not a login.
    cookies: z.array(WebExtCookieSchema).min(1).max(300),
});
export type WebExtSessionImport = z.infer<typeof WebExtSessionImportSchema>;
