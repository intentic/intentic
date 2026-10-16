import {
    DATA_FLOW_GROUPS,
    type DataFlow,
    type Measure,
    type MeasureCategory,
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

/* ---- Step 1: protections, with what the public-office preset recommends filed under each ---- */

// The protection a preset item changes. The page used to list the preset as a second list below the protections, so
// the same switch was read twice in two vocabularies; filed under its protection, a recommendation is read once, where
// what it protects is explained. Exhaustive over the contract's groups, so a new group fails this file's typecheck.
export const measureOfItem = (item: PresetItem): MeasureId => {
    switch (item.group) {
        case `privacy`: {
            return item.id === `privacy.images` ? `privacy-images` : item.id === `privacy.names` ? `privacy-names` : `privacy-shield`;
        }
        case `retention`: {
            return `retention`;
        }
        case `audit`: {
            return item.id === `audit.recordReads` ? `audit-reads` : `audit`;
        }
        case `analytics`: {
            return `product-analytics`;
        }
        case `notice`: {
            return `ai-notice`;
        }
        case `actions`: {
            return `action-rules`;
        }
        case `admission`: {
            return `admission`;
        }
        case `judge`: {
            return `command-judge`;
        }
    }
};

export interface Recommendation {
    readonly measure: Measure;
    /** What applying would change here, each one ticked to start with. */
    readonly changes: readonly PresetItem[];
    /** What the preset would change but this sandbox cannot take as it runs now, with the reason worded per item. */
    readonly unavailable: readonly PresetItem[];
}

// Every protection in one of three places, by what the reader can do about it: switch on what is recommended here,
// switch on more where it lives, or nothing, since it is in place. In the documents' category order.
export interface ProtectionPlan {
    readonly recommended: readonly Recommendation[];
    /** Not on, and nothing here to apply: changed where it lives, or out of this sandbox's reach (`unavailable` says why). */
    readonly more: readonly Pick<Recommendation, "measure" | "unavailable">[];
    readonly inPlace: readonly Measure[];
}

const CATEGORY_ORDER: readonly MeasureCategory[] = [`confidentiality`, `minimisation`, `integrity`, `accountability`, `transparency`, `availability`];

export const planProtections = (measures: readonly Measure[], items: readonly PresetItem[]): ProtectionPlan => {
    const ordered = measures.toSorted((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
    const pending = items.filter((item) => item.changes);
    const recommended: Recommendation[] = [];
    const more: Pick<Recommendation, "measure" | "unavailable">[] = [];
    const inPlace: Measure[] = [];
    for (const measure of ordered) {
        const mine = pending.filter((item) => measureOfItem(item) === measure.id);
        const changes = mine.filter((item) => item.available);
        const unavailable = mine.filter((item) => !item.available);
        if (changes.length > 0) {
            recommended.push({ measure, changes, unavailable });
        } else if (measure.status === `on`) {
            inPlace.push(measure);
        } else {
            more.push({ measure, unavailable });
        }
    }
    return { recommended, more, inPlace };
};

/* ---- Step 2: where data goes ---- */

export interface FlowList {
    /** In use now, in the page's group order. */
    readonly inUse: readonly DataFlow[];
    /** Listed because one switch would open them. */
    readonly idle: readonly DataFlow[];
}

export const sortFlows = (flows: readonly DataFlow[]): FlowList => {
    const ordered = flows.toSorted((a, b) => DATA_FLOW_GROUPS.indexOf(a.group) - DATA_FLOW_GROUPS.indexOf(b.group));
    return { inUse: ordered.filter((flow) => flow.active), idle: ordered.filter((flow) => !flow.active) };
};

// A place's name: the kind of place, and who runs it where that adds something. A name that is only the kind again
// (`web search`) adds nothing; a provider's or connector's own name does.
export const flowTitle = (flow: DataFlow): string => {
    const kind = t(`sandbox.dataProtection.kind.${keyOf(flow.kind)}`);
    const who = flow.operator ?? (flow.hosts.length > 0 || flow.kind === `team-chat` ? flow.name : undefined);
    return who === undefined || kind.toLowerCase().includes(who.toLowerCase()) ? kind : `${kind} · ${who}`;
};

export interface FlowFact {
    readonly text: string;
    readonly tone: Tone;
}

// How each fact reads. Quiet unless it says something: the shield's cover in green where it holds, and a transfer
// outside the EEA as the one warning, since that is what needs a legal basis. "Personal data" on a model or a chat is
// what a sandbox is for, and a list of amber dots for it said nothing the row's own words did not.
const PERSONAL_TONE = { yes: `info`, possible: `neutral`, no: `neutral` } as const satisfies Record<PersonalDataReach, Tone>;
const SHIELD_TONE = { masked: `success`, local: `success`, blocked: `success`, trusted: `info`, watched: `warning`, none: `neutral` } as const satisfies Record<
    ShieldCover,
    Tone
>;

// A place's three facts in reading order: whether personal data rides it, what the privacy shield does on it (left out
// where nothing personal travels), and where it is processed when that is known.
export const flowFacts = (flow: DataFlow): readonly FlowFact[] => {
    const facts: FlowFact[] = [{ text: t(`sandbox.dataProtection.personal.${flow.personalData}`), tone: PERSONAL_TONE[flow.personalData] }];
    if (flow.personalData !== `no`) {
        facts.push({ text: t(`sandbox.dataProtection.shield.${flow.shield}`), tone: SHIELD_TONE[flow.shield] });
    }
    if (flow.thirdCountry === true) {
        const text =
            flow.region === undefined ? t(`sandbox.dataProtection.outsideEea`) : t(`sandbox.dataProtection.outsideEeaIn`, { region: flow.region });
        facts.push({ text, tone: `warning` });
    } else if (flow.region !== undefined) {
        facts.push({ text: flow.region, tone: `neutral` });
    }
    return facts;
};

/* ---- What each step's tile says before it is opened ---- */

export interface StepCounts {
    readonly protectionsOn: number;
    readonly protections: number;
    /** Recommended changes this sandbox can take: what Apply would do with every box ticked. */
    readonly recommended: number;
    readonly places: number;
    readonly outsideEea: number;
    /** What only the office can answer, about the places in use. */
    readonly questions: number;
}

export const stepCounts = (measures: readonly Measure[], flows: readonly DataFlow[], items: readonly PresetItem[]): StepCounts => {
    const inUse = flows.filter((flow) => flow.active);
    return {
        protectionsOn: measures.filter((measure) => measure.status === `on`).length,
        protections: measures.length,
        recommended: items.filter((item) => item.changes && item.available).length,
        places: inUse.length,
        outsideEea: inUse.filter((flow) => flow.thirdCountry === true).length,
        questions: inUse.filter((flow) => flow.question !== undefined).length,
    };
};

export const STATUS_TONE = { on: `success`, partial: `info`, off: `warning`, unavailable: `neutral`, unknown: `neutral` } as const satisfies Record<
    MeasureStatus,
    Tone
>;

const tab = (name: string): RouteLocationRaw => ({ name: `sandbox`, params: { tab: name } });
const SHIELD = tab(`privacy-shield`);
const GUARDRAILS = tab(`guardrails`);
const RETENTION = tab(`retention`);
const AUDIT_KEEPING = { name: `sandbox`, params: { tab: `audit` }, query: { section: `keeping` } } as const;

// Where each measure is changed in the editor; one with no link here and a preset item points at the panel below on this
// page instead, and those set outside the editor (the key file, backups) have none. Until 2026-10-16 the shield's and the
// judge's went to Agent ▸ Safety, retention's to Agent ▸ Finishing, and the two approval floors had no page at all: the
// box-wide ones are this page's siblings under Privacy & safety now, and a measure about one thing (a member, an area,
// a secret, a model) still goes to that thing. Running the agent without administrator rights has no control in the
// editor (only its owner-only route), so it has no link: it went to Agent, which says nothing about it.
export const MEASURE_LINKS = new Map<MeasureId, RouteLocationRaw>([
    [`privacy-shield`, SHIELD],
    [`privacy-images`, SHIELD],
    [`privacy-names`, SHIELD],
    [`trusted-providers`, SHIELD],
    [`product-analytics`, SHIELD],
    [`command-judge`, GUARDRAILS],
    [`action-rules`, GUARDRAILS],
    [`admission`, GUARDRAILS],
    [`retention`, RETENTION],
    [`audit`, RETENTION],
    [`audit-reads`, AUDIT_KEEPING],
    [`audit-forward`, AUDIT_KEEPING],
    [`local-models`, tab(`models`)],
    [`member-roles`, tab(`access`)],
    [`guest-jail`, tab(`access`)],
    [`sign-in`, tab(`access`)],
    [`ai-notice`, tab(`access`)],
    [`areas`, tab(`areas`)],
    [`credential-gates`, tab(`secrets`)],
    [`host-guards`, tab(`secrets`)],
]);

// A preset item's own words: the setting it changes, and for an action rule, which action on which service.
export const presetLabel = (item: PresetItem): string => {
    if (item.group === `actions`) {
        const [service = ``, ...rest] = item.id.slice(`actionRules.`.length).split(`.`);
        if (service === `agents`) {
            return t(`sandbox.dataProtection.presetItem.agentsSpawn`);
        }
        return t(`sandbox.dataProtection.presetItem.action`, { service: serviceName(service), action: actionLabel(rest.join(`.`)) });
    }
    return t(`sandbox.dataProtection.presetItem.${keyOf(item.id)}`);
};

// Proper names, the same in every language. A service is its action keys' first segment (OUTWARD_ACTION_KEYS): e-mail is
// the IMAP extension's sender, so `imap`.
const SERVICE_NAMES = new Map([
    [`discord`, `Discord`],
    [`slack`, `Slack`],
    [`telegram`, `Telegram`],
    [`whatsapp`, `WhatsApp`],
    [`imap`, `e-mail`],
    [`microsoft365`, `Microsoft 365`],
    [`ezdrp`, `EZD RP`],
    [`edoreczenia`, `e-Doręczenia`],
]);
export const serviceName = (service: string): string => SERVICE_NAMES.get(service) ?? service;

// What one action does, by its key less the service (`message.send`, `document.register-incoming`).
export const actionLabel = (action: string): string => t(`sandbox.dataProtection.action.${keyOf(action)}`);

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
