import type { ComplianceReport, DataFlow, Measure, PresetApplyResult, PresetItem, PresetValue } from "@intentic/sandbox-contract/schemas/compliance";
import { setShieldPolicy, shieldPolicy } from "./shield";

// The data protection page's answers for the demo workspace: a fresh sandbox reached through Intentic's tunnel, with
// Claude connected and a Discord bot listening, and nothing of the public-office preset applied yet. Hand-written
// rather than computed: the mapping lives in the daemon (src/compliance/report.ts), which a browser tab cannot run.

const flows: DataFlow[] = [
    {
        id: `model-provider:claude`,
        group: `models`,
        kind: `model-provider`,
        name: `Claude Code`,
        hosts: [`api.anthropic.com`],
        operator: `Anthropic PBC`,
        region: `US`,
        thirdCountry: true,
        active: true,
        personalData: `yes`,
        shield: `none`,
        switch: `privacy`,
    },
    {
        id: `team-chat:discord`,
        group: `messaging`,
        kind: `team-chat`,
        name: `discord`,
        hosts: [`discord.com`, `gateway.discord.gg`, `cdn.discordapp.com`],
        operator: `Discord Inc.`,
        region: `US`,
        thirdCountry: true,
        active: true,
        personalData: `yes`,
        shield: `none`,
        switch: `actionRules`,
    },
    { id: `webchat`, group: `messaging`, kind: `webchat`, name: `web chat`, hosts: [], active: false, personalData: `yes`, shield: `none`, switch: `admission.webchat` },
    {
        id: `connector:github`,
        group: `connectors`,
        kind: `connector`,
        name: `github`,
        hosts: [`api.github.com`, `github.com`],
        active: true,
        personalData: `possible`,
        shield: `none`,
        switch: `capabilities`,
    },
    { id: `web-search`, group: `web`, kind: `web-search`, name: `web search`, hosts: [], active: true, personalData: `possible`, shield: `none` },
    { id: `web-fetch`, group: `web`, kind: `web-fetch`, name: `web pages`, hosts: [], active: true, personalData: `possible`, shield: `none` },
    { id: `browser`, group: `web`, kind: `browser`, name: `browser`, hosts: [], active: true, personalData: `possible`, shield: `none` },
    {
        id: `platform-link`,
        group: `platform`,
        kind: `platform-link`,
        name: `Intentic`,
        hosts: [`api.intentic.dev`],
        operator: `Intentic`,
        active: true,
        personalData: `yes`,
        shield: `none`,
        question: `platform-region`,
    },
    {
        id: `ingress`,
        group: `platform`,
        kind: `ingress`,
        name: `Intentic ingress`,
        hosts: [`ingress.sbx.intentic.dev`],
        operator: `Intentic (Fly.io)`,
        thirdCountry: true,
        active: true,
        personalData: `yes`,
        shield: `none`,
        question: `ingress-region`,
    },
    {
        id: `update-check`,
        group: `maintenance`,
        kind: `update-check`,
        name: `GitHub`,
        hosts: [`api.github.com`, `ghcr.io`],
        operator: `GitHub (Microsoft)`,
        region: `US`,
        thirdCountry: true,
        active: true,
        personalData: `no`,
        shield: `none`,
    },
    {
        id: `product-analytics`,
        group: `analytics`,
        kind: `product-analytics`,
        name: `PostHog`,
        hosts: [`us.i.posthog.com`],
        operator: `PostHog Inc.`,
        region: `US`,
        thirdCountry: true,
        active: true,
        personalData: `yes`,
        shield: `none`,
        switch: `productAnalytics`,
    },
];

const measure = (id: Measure[`id`], category: Measure[`category`], status: Measure[`status`], preset = false): Measure => ({ id, category, status, facts: {}, preset });

const measures: Measure[] = [
    measure(`privacy-shield`, `confidentiality`, `off`, true),
    measure(`privacy-images`, `confidentiality`, `off`, true),
    measure(`privacy-names`, `confidentiality`, `off`, true),
    measure(`trusted-providers`, `confidentiality`, `off`),
    measure(`local-models`, `minimisation`, `off`),
    measure(`member-roles`, `confidentiality`, `on`),
    measure(`areas`, `confidentiality`, `off`),
    measure(`guest-jail`, `confidentiality`, `on`),
    measure(`sign-in`, `confidentiality`, `on`),
    measure(`credential-gates`, `confidentiality`, `off`),
    measure(`host-guards`, `confidentiality`, `on`),
    measure(`encryption-at-rest`, `confidentiality`, `off`),
    measure(`encryption-in-transit`, `confidentiality`, `on`),
    measure(`action-rules`, `integrity`, `off`, true),
    measure(`admission`, `integrity`, `partial`, true),
    measure(`command-judge`, `integrity`, `on`, true),
    measure(`agent-domain`, `integrity`, `off`),
    measure(`retention`, `minimisation`, `off`, true),
    measure(`audit`, `accountability`, `on`, true),
    measure(`audit-reads`, `accountability`, `off`, true),
    measure(`audit-forward`, `accountability`, `off`),
    measure(`backups`, `availability`, `unknown`),
    measure(`product-analytics`, `minimisation`, `off`, true),
    measure(`ai-notice`, `transparency`, `off`, true),
    measure(`webchat-ai-disclosure`, `transparency`, `on`),
];

// What the preset has changed this page load, by item id: its value now, which the next preview reads as current.
const applied = new Map<string, PresetValue>();

// Which measure each preset item moves, and so turns on once applied: an exact id, or a whole group by its prefix.
const MOVES: readonly (readonly [string, Measure[`id`]])[] = [
    [`privacy.mode`, `privacy-shield`],
    [`privacy.images`, `privacy-images`],
    [`audit.recordReads`, `audit-reads`],
    [`productAnalytics`, `product-analytics`],
    [`aiNotice.show`, `ai-notice`],
    [`retention.`, `retention`],
    [`actionRules.`, `action-rules`],
    [`admission.`, `admission`],
];
const measureOf = (id: string): Measure[`id`] | undefined => MOVES.find(([key]) => (key.endsWith(`.`) ? id.startsWith(key) : id === key))?.[1];

const liveMeasures = (): Measure[] => {
    const moved = new Set([...applied.keys()].map(measureOf));
    return measures.map((row) => (moved.has(row.id) ? { ...row, status: `on` } : row));
};

export const demoComplianceReport = (): ComplianceReport => ({ generatedAt: new Date().toISOString(), flows, measures: liveMeasures() });

const item = (id: string, group: PresetItem[`group`], current: PresetItem[`current`], proposed: PresetItem[`proposed`], extra: Partial<PresetItem> = {}): PresetItem => ({
    id,
    group,
    current,
    proposed,
    changes: current !== proposed,
    available: true,
    owner: group === `privacy`,
    ...extra,
});

const seededItems = (): PresetItem[] => [
    item(`privacy.mode`, `privacy`, `off`, `on`),
    item(`privacy.images`, `privacy`, `mask`, `mask`),
    item(`privacy.names`, `privacy`, `dictionary`, `model`, { available: false }),
    item(`retention.transcriptDays`, `retention`, 0, 90),
    item(`retention.restorePointDays`, `retention`, 0, 30),
    item(`retention.privacyVaultDays`, `retention`, 0, 90),
    item(`retention.cacheDays`, `retention`, 0, 30),
    item(`retention.rawOutputDays`, `retention`, 0, 30),
    item(`audit.retentionDays`, `audit`, 365, 730),
    item(`audit.recordReads`, `audit`, false, true),
    item(`productAnalytics`, `analytics`, true, false),
    item(`aiNotice.show`, `notice`, false, true),
    item(`actionRules.discord.message.send`, `actions`, null, `hold`),
    item(`actionRules.slack.message.send`, `actions`, null, `hold`),
    item(`actionRules.agents.spawn`, `actions`, null, `hold`),
    item(`admission.listener`, `admission`, `allow`, `hold`),
    item(`admission.webchat`, `admission`, `allow`, `hold`),
    item(`admission.issues`, `admission`, `hold`, `hold`),
    item(`commandJudge`, `judge`, `on`, `on`),
];

export const demoPresetItems = (): PresetItem[] =>
    seededItems().map((row) => {
        if (!applied.has(row.id)) {
            return row;
        }
        const current = applied.get(row.id) ?? null;
        return { ...row, current, changes: current !== row.proposed };
    });

/** Applies the named items: each that can change does, the rest are skipped with why, as the daemon answers. */
export const applyPresetItems = (ids: readonly string[]): PresetApplyResult => {
    const items = demoPresetItems();
    const result: PresetApplyResult = { applied: [], skipped: [] };
    for (const id of ids) {
        const row = items.find((candidate) => candidate.id === id);
        if (row === undefined || !row.available || !row.changes) {
            result.skipped.push({ id, reason: row === undefined ? `unknown` : row.available ? `unchanged` : `unavailable` });
            continue;
        }
        applied.set(id, row.proposed);
        result.applied.push(id);
        if (id === `privacy.mode` && (row.proposed === `on` || row.proposed === `watch` || row.proposed === `off`)) {
            setShieldPolicy({ ...shieldPolicy(), mode: row.proposed });
        }
    }
    return result;
};
