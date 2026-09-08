// webext: the user's own browser (the `webext` capability's live half)
import { z } from "zod";
// origin is Chrome's own match pattern string for the grant, the same one the extension requested and the browser shows
// in its settings; mode is the extension's own read/act narrowing, which Chrome has no concept of.
export const WebExtGrantSchema = z.object({
    origin: z.string(),
    mode: z.enum(["read", "act"]),
});
export type WebExtGrant = z.infer<typeof WebExtGrantSchema>;
// What a connected browser reports about itself: mirrors HostFacts, adding exactly which sites it may touch right now.
export const WebExtFactsSchema = z.object({
    // How a person would name it: "Chrome 141 on Windows".
    browser: z.string(),
    // Count only; the list is a separate tool call and changes too often to show here.
    tabs: z.number(),
    // Live from the browser's permission store; a grant revoked in Chrome is not reflected until re-read.
    grants: z.array(WebExtGrantSchema),
    // Kill switch from the extension's popup; true means every tool refuses and reports why.
    paused: z.boolean(),
});
export type WebExtFacts = z.infer<typeof WebExtFactsSchema>;
export const WebExtSummarySchema = z.object({
    // id is the capability id and the prefix of its tools (mcp__<id>__click).
    id: z.string(),
    platform: z.string().min(1),
    online: z.boolean(),
    // Extension build version; an old build looks outdated rather than missing a tool.
    version: z.string().optional(),
    // Epoch ms of the last socket connection; absent after a restart rather than stale.
    lastSeen: z.number().optional(),
    facts: WebExtFactsSchema.optional(),
});
export type WebExtSummary = z.infer<typeof WebExtSummarySchema>;
export const WebExtsListSchema = z.object({ browsers: z.array(WebExtSummarySchema) });
// A credential: sent via the extension's own HTTPS request (webextSessionUrl), never the socket, since socket answers
// land in the model's context as MCP results; never logged or stored outside the target profile's cookie store.
export const WebExtCookieSchema = z.object({
    name: z.string(),
    value: z.string(),
    // Chrome's exact stored spelling, leading dot included; rewriting it breaks recognition by the target.
    domain: z.string(),
    path: z.string(),
    // Epoch seconds (Chrome's unit); absent means a session cookie that dies with the receiving browser.
    expires: z.number().optional(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(["Strict", "Lax", "None"]),
});
export type WebExtCookie = z.infer<typeof WebExtCookieSchema>;
export const WebExtSessionImportSchema = z.object({
    // The `browser`-kind capability whose profile receives this; must already exist in the roster.
    account: z.string().min(1),
    // Site of origin, shown to the owner only; each cookie carries its own domain for placement.
    origin: z.string().min(1),
    // Ceiling, not a real limit: past this many cookies for one domain the caller misused the tool.
    cookies: z.array(WebExtCookieSchema).min(1).max(300),
});
export type WebExtSessionImport = z.infer<typeof WebExtSessionImportSchema>;

// Lends a sandbox session to the person's own browser for passkeys, hardware 2FA, or device-checked SSO that remote
// driving cannot satisfy; same HTTPS-not-socket rule as the import above.
export const WebExtSessionExportSchema = z.object({
    // The `browser`-kind capability to lend from; named from the roster the agent can already read.
    account: z.string().min(1),
    // Registrable domain only; lending the whole profile would over-grant every account it holds.
    domain: z.string().min(1),
});
export type WebExtSessionExport = z.infer<typeof WebExtSessionExportSchema>;

export const WebExtSessionExportResultSchema = z.object({
    ok: z.boolean(),
    // Read by both the owner and the agent; never contains a cookie name or value.
    message: z.string(),
    // Read only by the extension, written straight into this browser's cookie store.
    cookies: z.array(WebExtCookieSchema).optional(),
});
export type WebExtSessionExportResult = z.infer<typeof WebExtSessionExportResultSchema>;
