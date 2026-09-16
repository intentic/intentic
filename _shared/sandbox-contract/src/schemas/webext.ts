// webext: the user's own browser (the `webext` capability's live half)
// Named imports rather than the `z` namespace: this module is bundled into the browser extension, where the
// namespace keeps zod's 60 locales (~250 kB) that esbuild can otherwise drop. _devices/webext/scripts/size-budget.mjs holds the ceiling.
import { array, boolean, enum as zEnum, number, object, string } from "zod";
import type * as z from "zod";
// The card's switches, here rather than in capabilities.ts because the extension bundles this module and would
// otherwise ship every other capability's schema to the store.
// The sibling of `host`, not an arm of it, since it's already signed in as the person, with their passkeys and SSO.
// Which sites the agent may touch lives in Chrome's own host permissions, not here; every switch is enforced in the
// extension, never checked on the daemon side.
const webextScope = zEnum(["on", "off"]);
export const WebExtScopesSchema = object({
    // The floor of usefulness, defaults on; off, the connection is inert and the card says so.
    read: webextScope.default("on"),
    // On by default, unlike a device's `control`: driving the page is what this connector is for, not a last resort.
    act: webextScope.default("on"),
    // Off by default: the one read nothing here bounds, since it captures whatever pixels the window shows, not just
    // granted frames.
    screenshot: webextScope.default("off"),
    // Off by default: the only switch here that copies a credential rather than borrowing the browser holding it.
    cookies: webextScope.default("off"),
    // "sensitive" (default) prompts only for a password, payment or delete action; "always" prompts every action,
    // "never" trusts the owner to watch.
    confirm: zEnum(["sensitive", "always", "never"]).default("sensitive"),
});
export type WebExtScopes = z.infer<typeof WebExtScopesSchema>;
// An open slug (chrome, firefox), like a host's `platform`: a new browser family needs no daemon release.
export const WebExtConfigSchema = WebExtScopesSchema.extend({ platform: string().min(1) });
export type WebExtConfig = z.infer<typeof WebExtConfigSchema>;
// origin is Chrome's own match pattern string for the grant, the same one the extension requested and the browser shows
// in its settings; mode is the extension's own read/act narrowing, which Chrome has no concept of.
export const WebExtGrantSchema = object({
    origin: string(),
    mode: zEnum(["read", "act"]),
});
export type WebExtGrant = z.infer<typeof WebExtGrantSchema>;
// What a connected browser reports about itself: mirrors HostFacts, adding exactly which sites it may touch right now.
export const WebExtFactsSchema = object({
    // How a person would name it: "Chrome 141 on Windows".
    browser: string(),
    // Count only; the list is a separate tool call and changes too often to show here.
    tabs: number(),
    // Live from the browser's permission store; a grant revoked in Chrome is not reflected until re-read.
    grants: array(WebExtGrantSchema),
    // Kill switch from the extension's popup; true means every tool refuses and reports why.
    paused: boolean(),
});
export type WebExtFacts = z.infer<typeof WebExtFactsSchema>;
export const WebExtSummarySchema = object({
    // id is the capability id and the prefix of its tools (mcp__<id>__click).
    id: string(),
    platform: string().min(1),
    online: boolean(),
    // Extension build version; an old build looks outdated rather than missing a tool.
    version: string().optional(),
    // Epoch ms of the last socket connection; absent after a restart rather than stale.
    lastSeen: number().optional(),
    facts: WebExtFactsSchema.optional(),
});
export type WebExtSummary = z.infer<typeof WebExtSummarySchema>;
export const WebExtsListSchema = object({ browsers: array(WebExtSummarySchema) });
// A credential: sent via the extension's own HTTPS request (webextSessionUrl), never the socket, since socket answers
// land in the model's context as MCP results; never logged or stored outside the target profile's cookie store.
export const WebExtCookieSchema = object({
    name: string(),
    value: string(),
    // Chrome's exact stored spelling, leading dot included; rewriting it breaks recognition by the target.
    domain: string(),
    path: string(),
    // Epoch seconds (Chrome's unit); absent means a session cookie that dies with the receiving browser.
    expires: number().optional(),
    httpOnly: boolean(),
    secure: boolean(),
    sameSite: zEnum(["Strict", "Lax", "None"]),
});
export type WebExtCookie = z.infer<typeof WebExtCookieSchema>;
export const WebExtSessionImportSchema = object({
    // The `browser`-kind capability whose profile receives this; must already exist in the roster.
    account: string().min(1),
    // Site of origin, shown to the owner only; each cookie carries its own domain for placement.
    origin: string().min(1),
    // Ceiling, not a real limit: past this many cookies for one domain the caller misused the tool.
    cookies: array(WebExtCookieSchema).min(1).max(300),
});
export type WebExtSessionImport = z.infer<typeof WebExtSessionImportSchema>;

// Lends a sandbox session to the person's own browser for passkeys, hardware 2FA, or device-checked SSO that remote
// driving cannot satisfy; same HTTPS-not-socket rule as the import above.
export const WebExtSessionExportSchema = object({
    // The `browser`-kind capability to lend from; named from the roster the agent can already read.
    account: string().min(1),
    // Registrable domain only; lending the whole profile would over-grant every account it holds.
    domain: string().min(1),
});
export type WebExtSessionExport = z.infer<typeof WebExtSessionExportSchema>;

export const WebExtSessionExportResultSchema = object({
    ok: boolean(),
    // Read by both the owner and the agent; never contains a cookie name or value.
    message: string(),
    // Read only by the extension, written straight into this browser's cookie store.
    cookies: array(WebExtCookieSchema).optional(),
});
export type WebExtSessionExportResult = z.infer<typeof WebExtSessionExportResultSchema>;
