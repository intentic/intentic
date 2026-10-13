import type { DataFlow, PresetItem } from "@intentic/sandbox-contract";
import { documentLanguageFor, groupFlows, keyOf, MEASURE_LINKS, presetLabel, presetValue } from "./dataProtection";

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

// "Change" opens the setting itself wherever the editor has one, and the preset only tightens, so a measure with a home is
// sent there rather than to the panel at the foot of the page.
it(`sends the audit trail's, retention's and the people-facing measures to where each is set`, () => {
    const keeping = { name: `sandbox`, params: { tab: `audit` }, query: { section: `keeping` } };
    expect(MEASURE_LINKS.get(`audit`)).toEqual(keeping);
    expect(MEASURE_LINKS.get(`audit-reads`)).toEqual(keeping);
    expect(MEASURE_LINKS.get(`audit-forward`)).toEqual(keeping);
    expect(MEASURE_LINKS.get(`retention`)).toEqual({ name: `sandbox`, params: { tab: `agent` }, query: { section: `finishing` } });
    expect(MEASURE_LINKS.get(`ai-notice`)).toEqual({ name: `sandbox`, params: { tab: `access` } });
    expect(MEASURE_LINKS.get(`product-analytics`)).toEqual({ name: `sandbox`, params: { tab: `access` } });
});
