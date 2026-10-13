import type { DataFlow, PresetItem } from "@intentic/sandbox-contract";
import { documentLanguageFor, groupFlows, keyOf, presetLabel, presetValue } from "./dataProtection";

// The data protection page's table: flows grouped in the page's order with those in use first, catalog keys derived
// from the daemon's ids, and a preset value worded the way its setting means it.

const flow = (id: string, group: DataFlow[`group`], active: boolean): DataFlow => ({
    id,
    group,
    kind: `connector`,
    name: id,
    hosts: [],
    active,
    personalData: `possible`,
    shield: `none`,
});

const item = (id: string, group: PresetItem[`group`]): PresetItem => ({ id, group, current: null, proposed: null, changes: true, available: true, owner: false });

it(`groups flows in the page's order, those in use first, and leaves empty groups out`, () => {
    const groups = groupFlows([flow(`b`, `web`, false), flow(`a`, `analytics`, true), flow(`c`, `web`, true), flow(`d`, `models`, true)]);
    expect(groups.map((entry) => entry.group)).toEqual([`models`, `web`, `analytics`]);
    expect(groups[1]?.flows.map((entry) => entry.id)).toEqual([`c`, `b`]);
});

it(`turns the daemon's ids into catalog keys`, () => {
    expect(keyOf(`model-provider`)).toBe(`modelProvider`);
    expect(keyOf(`webchat-ai-disclosure`)).toBe(`webchatAiDisclosure`);
    expect(keyOf(`retention.transcriptDays`)).toBe(`retentionTranscriptDays`);
    expect(keyOf(`aiNotice.show`)).toBe(`aiNoticeShow`);
});

it(`words a retention of zero as forever, a switch as on or off, and no rule as allowed`, () => {
    const days = item(`retention.cacheDays`, `retention`);
    expect(presetValue(days, 0)).toBe(`kept forever`);
    expect(presetValue(days, 30)).toBe(`30 days`);
    expect(presetValue(item(`audit.retentionDays`, `audit`), 730)).toBe(`730 days`);
    expect(presetValue(item(`productAnalytics`, `analytics`), false)).toBe(`off`);
    expect(presetValue(item(`actionRules.slack.message.send`, `actions`), null)).toBe(`allowed`);
    expect(presetValue(item(`actionRules.slack.message.send`, `actions`), `hold`)).toBe(`asks first`);
});

it(`names an action rule by its action and service`, () => {
    expect(presetLabel(item(`actionRules.slack.message.send`, `actions`))).toBe(`Sending messages on Slack`);
    expect(presetLabel(item(`actionRules.agents.spawn`, `actions`))).toBe(`Starting more agents`);
    expect(presetLabel(item(`privacy.mode`, `privacy`))).toBe(`Privacy shield`);
});

it(`writes the documents in Polish for a Polish reader and in English for anyone else`, () => {
    expect(documentLanguageFor(`pl`)).toBe(`pl`);
    expect(documentLanguageFor(`de`)).toBe(`en`);
});
