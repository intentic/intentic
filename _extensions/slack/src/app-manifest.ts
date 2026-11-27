// THE SLACK APP THIS INTEGRATION NEEDS, written once: what Slack's "create an app from a manifest" page is handed. Two
// shapes of one app (2026-11-27):
// - Socket Mode, the default and app-manifest.json's (held equal to it by app-manifest.test.ts), which the card's
//   guide link fills in: the gateway holds an outbound WebSocket, so no public URL is needed, but nothing is heard
//   while the sandbox is not running.
// - Request URLs, for a sandbox the platform hosts, which sleeps when nobody uses it: Slack POSTs every event and button
//   press to the sandbox's wake URL for the `events` public route (`api.sleep.wakeUrl`), and a request that arrives
//   while it sleeps wakes it, so Slack's retry is heard. Socket Mode is off, since Slack sends nothing to a URL while
//   it is on.

// The public route Slack's Request URLs name (`contributes.publicRoutes`, `wakes: true`): events and interactivity alike.
export const EVENTS_ROUTE = "events";

const BOT_SCOPES = [
    "app_mentions:read",
    "channels:history",
    "channels:read",
    "chat:write",
    "groups:history",
    "groups:read",
    "im:history",
    "im:read",
    "im:write",
    "mpim:history",
    "reactions:read",
    "reactions:write",
    "users:read",
] as const;

// What the gateway listens for: messages wherever the app is, reactions (⏹️ is Stop), and being invited (the hello).
const BOT_EVENTS = ["message.channels", "message.groups", "message.im", "message.mpim", "reaction_added", "member_joined_channel"] as const;

export interface SlackAppManifest {
    readonly display_information: { readonly name: string; readonly description: string };
    readonly features: {
        readonly app_home: { readonly home_tab_enabled: boolean; readonly messages_tab_enabled: boolean; readonly messages_tab_read_only_enabled: boolean };
        readonly bot_user: { readonly display_name: string; readonly always_online: boolean };
    };
    readonly oauth_config: { readonly scopes: { readonly bot: readonly string[] } };
    readonly settings: {
        readonly event_subscriptions: { readonly request_url?: string; readonly bot_events: readonly string[] };
        readonly interactivity: { readonly is_enabled: boolean; readonly request_url?: string };
        readonly socket_mode_enabled: boolean;
    };
}

/** The app's manifest: Socket Mode with no `requestUrl`, else Slack's events and button presses POSTed to `requestUrl`. */
export const slackAppManifest = (requestUrl?: string): SlackAppManifest => ({
    display_information: { name: "intentic", description: "Your agent, in Slack." },
    features: {
        app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
        bot_user: { display_name: "intentic", always_online: true },
    },
    oauth_config: { scopes: { bot: [...BOT_SCOPES] } },
    settings:
        requestUrl === undefined
            ? { event_subscriptions: { bot_events: [...BOT_EVENTS] }, interactivity: { is_enabled: true }, socket_mode_enabled: true }
            : {
                  event_subscriptions: { request_url: requestUrl, bot_events: [...BOT_EVENTS] },
                  interactivity: { is_enabled: true, request_url: requestUrl },
                  socket_mode_enabled: false,
              },
});

/** The link Slack documents for sharing a manifest: its "create an app" page with the manifest filled in. */
export const createAppLink = (manifest: SlackAppManifest): string =>
    `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;

/**
 * What the owner of a sandbox the platform hosts is told once about a Slack app still on Socket Mode: it only answers
 * while the sandbox is awake, the one step that switches it (`requestUrl` is the wake URL), and a link that creates an
 * app already set up that way, for starting over.
 */
export const socketModeAsleepNotice = (requestUrl: string): string =>
    [
        "This Slack app reaches the sandbox over Socket Mode, so it only answers while the sandbox is awake: a mention sent while it sleeps is never heard.",
        `To answer while it sleeps, in the app's settings on api.slack.com/apps turn Socket Mode off, set the Request URL under Event Subscriptions and under Interactivity & Shortcuts to ${requestUrl} , then paste the app's Signing Secret (Basic Information) on the Slack card.`,
        `Or create a new app already set up that way: ${createAppLink(slackAppManifest(requestUrl))}`,
    ].join(" ");
