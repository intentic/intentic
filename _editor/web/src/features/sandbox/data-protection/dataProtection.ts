import {
    DATA_FLOW_GROUPS,
    type DataFlow,
    type DataFlowGroup,
    type MeasureId,
    type MeasureStatus,
    type PersonalDataReach,
    type PresetItem,
    type PresetValue,
    type ShieldCover,
} from "@intentic/sandbox-contract";
import type { Tone } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { RouteLocationRaw } from "vue-router";

// The data protection page's wording and grouping, kept out of the component so the mapping reads as a table and is
// tested as one. Ids from the daemon are kebab-case (`model-provider`); catalog keys are camelCase.

export const keyOf = (id: string): string => id.replace(/[-.]([a-z])/gu, (_, letter: string) => letter.toUpperCase());

export interface FlowGroup {
    readonly group: DataFlowGroup;
    readonly flows: readonly DataFlow[];
}

// In use first within each group, then what one switch would open; groups with nothing in them are left out.
export const groupFlows = (flows: readonly DataFlow[]): FlowGroup[] =>
    DATA_FLOW_GROUPS.flatMap((group) => {
        const members = flows.filter((flow) => flow.group === group).toSorted((a, b) => Number(b.active) - Number(a.active));
        return members.length === 0 ? [] : [{ group, flows: members }];
    });

export const PERSONAL_TONE = { yes: `warning`, possible: `info`, no: `neutral` } as const satisfies Record<PersonalDataReach, Tone>;
export const SHIELD_TONE = {
    masked: `success`,
    local: `success`,
    blocked: `success`,
    trusted: `info`,
    watched: `warning`,
    none: `neutral`,
} as const satisfies Record<ShieldCover, Tone>;
export const STATUS_TONE = { on: `success`, partial: `info`, off: `warning`, unavailable: `neutral`, unknown: `neutral` } as const satisfies Record<
    MeasureStatus,
    Tone
>;

const SAFETY = { name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } } as const;
const RETENTION = { name: `sandbox`, params: { tab: `agent` }, query: { section: `finishing` } } as const;
const AUDIT_KEEPING = { name: `sandbox`, params: { tab: `audit` }, query: { section: `keeping` } } as const;
const tab = (name: string): RouteLocationRaw => ({ name: `sandbox`, params: { tab: name } });

// Where each measure is changed in the editor; one with no link here and a preset item points at the panel below on this
// page instead, and those set outside the editor (the key file, backups) have none. The audit trail's, retention's, the
// AI notice's and analytics' went to that panel until 2026-10-13, which only ever tightens them.
export const MEASURE_LINKS = new Map<MeasureId, RouteLocationRaw>([
    [`privacy-shield`, SAFETY],
    [`privacy-images`, SAFETY],
    [`privacy-names`, SAFETY],
    [`trusted-providers`, SAFETY],
    [`command-judge`, SAFETY],
    [`local-models`, tab(`models`)],
    [`member-roles`, tab(`access`)],
    [`guest-jail`, tab(`access`)],
    [`sign-in`, tab(`access`)],
    [`areas`, tab(`areas`)],
    [`credential-gates`, tab(`secrets`)],
    [`host-guards`, tab(`secrets`)],
    [`agent-domain`, tab(`agent`)],
    [`retention`, RETENTION],
    [`audit`, AUDIT_KEEPING],
    [`audit-reads`, AUDIT_KEEPING],
    [`audit-forward`, AUDIT_KEEPING],
    [`ai-notice`, tab(`access`)],
    [`product-analytics`, tab(`access`)],
]);

// A preset item's own words: the setting it changes, and for an action rule, which action on which service.
export const presetLabel = (item: PresetItem): string => {
    if (item.group === `actions`) {
        const [service = ``, ...rest] = item.id.slice(`actionRules.`.length).split(`.`);
        if (service === `agents`) {
            return t(`sandbox.dataProtection.presetItem.agentsSpawn`);
        }
        return t(`sandbox.dataProtection.presetItem.action`, { service: serviceName(service), action: t(`sandbox.dataProtection.action.${keyOf(rest.join(`.`))}`) });
    }
    return t(`sandbox.dataProtection.presetItem.${keyOf(item.id)}`);
};

const SERVICE_NAMES = new Map([
    [`discord`, `Discord`],
    [`slack`, `Slack`],
    [`telegram`, `Telegram`],
    [`whatsapp`, `WhatsApp`],
    [`email`, `e-mail`],
]);
export const serviceName = (service: string): string => SERVICE_NAMES.get(service) ?? service;

const SWITCHES = new Set([`audit.recordReads`, `productAnalytics`, `aiNotice.show`]);
const DAY_COUNTS = new Set([`audit.retentionDays`]);

// A value as the reader knows it: days for a retention, on and off for a switch, the rule's word for a rule. Zero days
// is "forever", which is what the setting means; an action nobody wrote a rule for is allowed.
export const presetValue = (item: PresetItem, value: PresetValue): string => {
    if (value === null) {
        return t(`sandbox.dataProtection.value.allow`);
    }
    if (SWITCHES.has(item.id)) {
        return t(value === true ? `sandbox.dataProtection.value.on` : `sandbox.dataProtection.value.off`);
    }
    if (item.group === `retention` || DAY_COUNTS.has(item.id)) {
        const days = Number(value);
        return days === 0 ? t(`sandbox.dataProtection.value.forever`) : t(`sandbox.dataProtection.value.days`, { n: days }, days);
    }
    return t(`sandbox.dataProtection.value.${keyOf(String(value))}`);
};

// The questions a flow leaves for the office, by the daemon's key.
export const questionText = (question: string): string => t(`sandbox.dataProtection.question.${keyOf(question)}`);

// The two languages the documents are written in; the UI's own language picks the first, any other gets English.
export const documentLanguageFor = (locale: string): `pl` | `en` => (locale === `pl` ? `pl` : `en`);
