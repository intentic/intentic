import { ExtensionManifestSchema, ListenerContributionSchema } from "@intentic/extension-api";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { listenerSourceOf, listenerSourcesOf } from "./listenerSources";

const slack: ExtensionSummary = {
    id: `intentic.slack`,
    commit: `builtin`,
    source: `builtin`,
    enabled: true,
    manifest: ExtensionManifestSchema.parse({
        publisher: `intentic`,
        name: `slack`,
        version: `1.0.0`,
        engines: { intentic: `^2.0.0` },
        icon: `slack`,
        contributes: {
            listener: {
                provider: `slack`,
                events: [
                    { type: `message`, label: `Messages` },
                    { type: `reaction_added`, label: `Reactions` },
                ],
                automation: {
                    label: `Slack`,
                    mentionLabel: `Only when addressed`,
                    channel: { label: `Channel`, placeholder: `all channels` },
                    starterPrompt: `Handle Slack events.`,
                },
            },
            capabilities: [
                {
                    id: `slack`,
                    kind: `cli`,
                    catalog: { name: `Slack`, icon: `slack`, description: `Slack`, category: `communication` },
                    fields: [{ key: `token`, label: `Bot token`, secret: true }],
                    env: { SLACK_BOT_TOKEN: `\${token}` },
                    skill: `skills/slack/SKILL.md`,
                },
            ],
        },
    }),
};

describe(`listenerSourcesOf`, () => {
    it(`derives a provider and all of its events from the installed contribution`, () => {
        const sources = listenerSourcesOf([slack], [{ id: `work`, kind: `cli`, config: { provider: `slack` } }]);
        expect(sources.find((source) => source.provider === `slack`)).toMatchObject({
            label: `Slack`,
            icon: `slack`,
            available: true,
            events: [
                { value: `message`, label: `Messages` },
                { value: `reaction_added`, label: `Reactions` },
            ],
        });
    });

    it(`keeps a disconnected provider describable without offering it as live`, () => {
        const source = listenerSourcesOf([slack], []).find((entry) => entry.provider === `slack`);
        expect(source).toMatchObject({ label: `Slack`, available: false });
    });
});

describe(`the public listener contribution`, () => {
    it(`rejects duplicate event ids before the editor and daemon can disagree about them`, () => {
        expect(
            ListenerContributionSchema.safeParse({
                provider: `feed`,
                events: [
                    { type: `published`, label: `Published` },
                    { type: `published`, label: `Published again` },
                ],
                automation: {
                    label: `Feed`,
                    channel: { label: `Feed`, placeholder: `all feeds` },
                    starterPrompt: `Handle feed events.`,
                },
            }).success,
        ).toBe(false);
    });
});

describe(`listenerSourceOf`, () => {
    it(`keeps an automation readable after its provider extension is removed`, () => {
        expect(listenerSourceOf([], `acme-feed`, `published`)).toMatchObject({
            provider: `acme-feed`,
            label: `acme-feed`,
            available: false,
            events: [{ value: `published`, label: `published` }],
        });
    });
});
