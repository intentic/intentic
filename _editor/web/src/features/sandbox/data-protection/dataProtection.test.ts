import type { DataFlow, Measure, PresetItem } from "@intentic/sandbox-contract";
import {
    documentLanguageFor,
    flowFacts,
    flowTitle,
    keyOf,
    MEASURE_LINKS,
    measureOfItem,
    planProtections,
    presetLabel,
    presetValue,
    sortFlows,
    stepCounts,
} from "./dataProtection";

// The data protection page's table: each recommendation filed under the protection it changes, every protection in the
// bucket of what the reader can do about it, what each step's tile counts, places in the page's order with their facts,
// catalog keys derived from the daemon's ids, and a preset value worded the way its setting means it.

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

const item = (id: string, group: PresetItem[`group`], extra: Partial<PresetItem> = {}): PresetItem => ({
    id,
    group,
    current: null,
    proposed: null,
    changes: true,
    available: true,
    owner: false,
    ...extra,
});

const measure = (id: Measure[`id`], status: Measure[`status`], category: Measure[`category`] = `confidentiality`): Measure => ({
    id,
    category,
    status,
    facts: {},
    preset: false,
});

it(`files each recommendation under the protection it switches`, () => {
    expect(measureOfItem(item(`privacy.mode`, `privacy`))).toBe(`privacy-shield`);
    expect(measureOfItem(item(`privacy.images`, `privacy`))).toBe(`privacy-images`);
    expect(measureOfItem(item(`privacy.names`, `privacy`))).toBe(`privacy-names`);
    expect(measureOfItem(item(`retention.cacheDays`, `retention`))).toBe(`retention`);
    expect(measureOfItem(item(`audit.retentionDays`, `audit`))).toBe(`audit`);
    expect(measureOfItem(item(`audit.recordReads`, `audit`))).toBe(`audit-reads`);
    expect(measureOfItem(item(`productAnalytics`, `analytics`))).toBe(`product-analytics`);
    expect(measureOfItem(item(`aiNotice.show`, `notice`))).toBe(`ai-notice`);
    expect(measureOfItem(item(`actionRules.slack.message.send`, `actions`))).toBe(`action-rules`);
    expect(measureOfItem(item(`admission.webchat`, `admission`))).toBe(`admission`);
    expect(measureOfItem(item(`commandJudge`, `judge`))).toBe(`command-judge`);
});

it(`puts what the preset would change first, what is on last, and everything else between`, () => {
    const plan = planProtections(
        [
            measure(`audit`, `on`, `accountability`),
            measure(`retention`, `off`, `minimisation`),
            measure(`privacy-shield`, `off`),
            measure(`areas`, `off`),
            measure(`sign-in`, `on`),
            measure(`command-judge`, `on`, `integrity`),
        ],
        [
            item(`retention.cacheDays`, `retention`),
            item(`retention.transcriptDays`, `retention`),
            item(`privacy.mode`, `privacy`),
            item(`audit.retentionDays`, `audit`),
            // Already as proposed: nothing to apply, so its protection reads as it stands.
            item(`commandJudge`, `judge`, { changes: false }),
        ],
    );
    // In the documents' category order, not the report's.
    expect(plan.recommended.map((entry) => entry.measure.id)).toEqual([`privacy-shield`, `retention`, `audit`]);
    expect(plan.recommended[1]?.changes.map((entry) => entry.id)).toEqual([`retention.cacheDays`, `retention.transcriptDays`]);
    expect(plan.more.map((entry) => entry.measure.id)).toEqual([`areas`]);
    expect(plan.inPlace.map((entry) => entry.id)).toEqual([`sign-in`, `command-judge`]);
});

it(`keeps a recommendation this sandbox cannot take beside its protection, with nothing to tick`, () => {
    const plan = planProtections([measure(`privacy-names`, `off`)], [item(`privacy.names`, `privacy`, { available: false })]);
    expect(plan.recommended).toEqual([]);
    expect(plan.more.map((entry) => [entry.measure.id, entry.unavailable.map((unable) => unable.id)])).toEqual([[`privacy-names`, [`privacy.names`]]]);
});

it(`counts what each step's tile says before it is opened`, () => {
    const counts = stepCounts(
        [measure(`audit`, `on`), measure(`areas`, `off`), measure(`sign-in`, `on`)],
        [
            { ...flow(`claude`, `models`, true), thirdCountry: true },
            { ...flow(`ingress`, `platform`, true), thirdCountry: true, question: `ingress-region` },
            { ...flow(`mail`, `messaging`, false), thirdCountry: true, question: `mail-operator` },
        ],
        [item(`privacy.mode`, `privacy`), item(`privacy.names`, `privacy`, { available: false }), item(`commandJudge`, `judge`, { changes: false })],
    );
    // A place not in use asks the office nothing and transfers nothing yet; a change the sandbox cannot take is not one to apply.
    expect(counts).toEqual({ protectionsOn: 2, protections: 3, recommended: 1, places: 2, outsideEea: 2, questions: 1 });
});

it(`lists places in use in the page's order, and those one switch would open apart`, () => {
    const list = sortFlows([flow(`b`, `web`, false), flow(`a`, `analytics`, true), flow(`c`, `web`, true), flow(`d`, `models`, true)]);
    expect(list.inUse.map((entry) => entry.id)).toEqual([`d`, `c`, `a`]);
    expect(list.idle.map((entry) => entry.id)).toEqual([`b`]);
});

it(`says a place's facts quietly, and a transfer outside the EEA as the one warning`, () => {
    const claude: DataFlow = { ...flow(`claude`, `models`, true), personalData: `yes`, shield: `masked`, thirdCountry: true, region: `US` };
    expect(flowFacts(claude)).toEqual([
        { text: `personal data`, tone: `info` },
        { text: `shielded`, tone: `success` },
        { text: `outside the EEA (US)`, tone: `warning` },
    ]);
    // Nothing personal travels on an update check, so what the shield does there is not said at all.
    const updates: DataFlow = { ...flow(`updates`, `maintenance`, true), personalData: `no`, region: `EU` };
    expect(flowFacts(updates)).toEqual([
        { text: `no personal data`, tone: `neutral` },
        { text: `EU`, tone: `neutral` },
    ]);
});

it(`names a place by its kind, and by who runs it where that adds something`, () => {
    expect(flowTitle({ ...flow(`claude`, `models`, true), kind: `model-provider`, operator: `Anthropic PBC` })).toBe(`AI model provider · Anthropic PBC`);
    expect(flowTitle({ ...flow(`search`, `web`, true), kind: `web-search`, name: `web search` })).toBe(`Web search`);
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
