import { readFileSync } from "node:fs";

// app-manifest.json is the one place the Slack app this integration needs is written down; the card's guide link carries
// it to Slack's "create an app" page, so the link is held equal to it here rather than edited by hand.

const text = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

interface SlackCard {
    readonly id: string;
    readonly catalog: { readonly guide?: { readonly url?: string } };
}
const extension: { readonly contributes: { readonly capabilities: readonly SlackCard[] } } = JSON.parse(text(`../intentic-extension.json`));
const manifest: Record<string, unknown> = JSON.parse(text(`../app-manifest.json`));

// The link Slack documents for sharing a manifest: https://api.slack.com/apps?new_app=1&manifest_json=<url-encoded JSON>.
const createLink = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;

test(`the card's guide link opens Slack with app-manifest.json filled in`, () => {
    const card = extension.contributes.capabilities.find((candidate) => candidate.id === `slack`);

    expect(card?.catalog.guide?.url).toBe(createLink);
});

test(`the manifest switches on what the gateway relies on, so nobody toggles it by hand`, () => {
    expect(manifest).toMatchObject({
        settings: {
            socket_mode_enabled: true,
            interactivity: { is_enabled: true },
            event_subscriptions: { bot_events: expect.arrayContaining([`message.channels`, `reaction_added`, `member_joined_channel`]) },
        },
    });
});
