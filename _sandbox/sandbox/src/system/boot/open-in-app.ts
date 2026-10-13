import type { Context } from "hono";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { allowedOriginsOf } from "../../auth/browser-origins.js";
import type { Config } from "../../env.config.js";

// GET / (contract raw-routes.ts). A person who opens this sandbox's own address in a browser is sent to the app's /open
// on it, which probes it and opens it, through the platform when that answers and directly when it does not: the
// address is the one thing they may still hold when the platform has lost the rest (2026-10-02). Only a navigation is
// redirected; an API client keeps the 401 every unauthenticated request got here before.

// The two facts the redirect reads: which origins the app is served from, and this sandbox's public address.
export type OpenInAppConfig = Pick<Config, "webOrigin"> & { readonly sandbox: Pick<Config["sandbox"], "publicUrl"> };

// Where a navigation goes: the first origin this sandbox serves its app to. Undefined for anything but a navigation, or
// for a sandbox with no public address to name.
export const openInAppTarget = (config: OpenInAppConfig, accept: string | undefined): string | undefined => {
    const origin = allowedOriginsOf(config.webOrigin)[0];
    if (origin === undefined || config.sandbox.publicUrl === "" || accept?.includes("text/html") !== true) {
        return undefined;
    }
    return `${origin}/open?url=${encodeURIComponent(config.sandbox.publicUrl)}`;
};

export const openInApp = (config: OpenInAppConfig, c: Context): Response => {
    const target = openInAppTarget(config, c.req.header("accept"));
    return target === undefined ? c.json({ error: "unauthorized" }, 401) : c.redirect(target, 302);
};

// What a link to one conversation reads: the app's origin, and this sandbox's platform id when it has one.
export type ConversationLinkConfig = Pick<Config, "webOrigin" | "connectToken">;

// A link that opens one conversation in the app, for a channel the conversation answers into (a Discord thread's
// status card): the app's first origin, on this sandbox when the platform knows it (`?sandbox=`, which the app takes only
// for a sandbox the reader's account lists), on that conversation (`?conversation=`, the route a push opens). Undefined
// when no origin is configured, since a link that leads nowhere is worse than none.
export const conversationLink = (config: ConversationLinkConfig, conversationId: string): string | undefined => {
    const origin = allowedOriginsOf(config.webOrigin)[0];
    if (origin === undefined) {
        return undefined;
    }
    const query = new URLSearchParams();
    const sandboxId = sandboxIdFromToken(config.connectToken);
    if (sandboxId !== undefined) {
        query.set("sandbox", sandboxId);
    }
    query.set("conversation", conversationId);
    return `${origin.replace(/\/+$/, "")}/?${query.toString()}`;
};
