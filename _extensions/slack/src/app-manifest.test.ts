import { readFileSync } from "node:fs";
import { createAppLink, EVENTS_ROUTE, type SlackAppManifest, slackAppManifest, socketModeAsleepNotice } from "./app-manifest.js";

// app-manifest.json is the Socket Mode app, written out where people read it; app-manifest.ts is where the app is
// written down, in both of its shapes. The card's guide link carries the Socket Mode one to Slack's "create an app"
// page, so the file and the link are held equal to the code here rather than edited by hand.

const text = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

interface SlackCard {
    readonly id: string;
    readonly catalog: { readonly guide?: { readonly url?: string } };
}
interface PublicRoute {
    readonly path: string;
    readonly methods: readonly string[];
    readonly wakes?: boolean;
}
const extension: { readonly contributes: { readonly capabilities: readonly SlackCard[]; readonly publicRoutes: readonly PublicRoute[] } } = JSON.parse(
    text(`../intentic-extension.json`),
);
// Read as the app it is held equal to below.
const manifest: SlackAppManifest = JSON.parse(text(`../app-manifest.json`));

const REQUEST_URL = `https://sandbox.example/door/intentic.slack/events?wake=s3cret`;

test(`app-manifest.json is the Socket Mode app the code writes`, () => {
    expect(manifest).toEqual(slackAppManifest());
});

test(`the card's guide link opens Slack with the Socket Mode app filled in`, () => {
    const card = extension.contributes.capabilities.find((candidate) => candidate.id === `slack`);

    // The link Slack documents for sharing a manifest: https://api.slack.com/apps?new_app=1&manifest_json=<url-encoded JSON>.
    expect(card?.catalog.guide?.url).toBe(`https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`);
    expect(card?.catalog.guide?.url).toBe(createAppLink(slackAppManifest()));
});

test(`the Socket Mode app switches on what the gateway relies on, so nobody toggles it by hand`, () => {
    expect(slackAppManifest()).toMatchObject({
        settings: {
            socket_mode_enabled: true,
            interactivity: { is_enabled: true },
            event_subscriptions: { bot_events: expect.arrayContaining([`message.channels`, `reaction_added`, `member_joined_channel`]) },
        },
    });
    expect(slackAppManifest().settings.event_subscriptions).not.toHaveProperty(`request_url`);
});

test(`a hosted sandbox's app sends events and button presses to its wake URL, with Socket Mode off`, () => {
    expect(slackAppManifest(REQUEST_URL).settings).toEqual({
        event_subscriptions: { request_url: REQUEST_URL, bot_events: slackAppManifest().settings.event_subscriptions.bot_events },
        interactivity: { is_enabled: true, request_url: REQUEST_URL },
        socket_mode_enabled: false,
    });
    // Everything but how Slack reaches the sandbox is the same app.
    const { settings: _hosted, ...hostedRest } = slackAppManifest(REQUEST_URL);
    const { settings: _socket, ...socketRest } = slackAppManifest();
    expect(hostedRest).toEqual(socketRest);
});

test(`the route the Request URL names is declared, takes Slack's POSTs and wakes the sandbox`, () => {
    expect(extension.contributes.publicRoutes.find((route) => route.path === EVENTS_ROUTE)).toMatchObject({ path: `events`, methods: [`POST`], wakes: true });
});

test(`the notice for a hosted app still on Socket Mode names the Request URL to set and a link to an app already set`, () => {
    const notice = socketModeAsleepNotice(REQUEST_URL);
    expect(notice).toContain(`only answers while the sandbox is awake`);
    expect(notice).toContain(`set the Request URL under Event Subscriptions and under Interactivity & Shortcuts to ${REQUEST_URL} ,`);
    expect(notice).toContain(`Signing Secret`);
    expect(notice).toContain(createAppLink(slackAppManifest(REQUEST_URL)));
});
