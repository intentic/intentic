import {
    AUDIT_RETENTION_DAYS_PUBLIC_OFFICE,
    type AdmissionPolicy,
    type AdmissionRule,
    AdmissionRuleSchema,
    type PresetApplyResult,
    type PresetGroup,
    type PresetItem,
    type PresetValue,
    type PrivacyShieldPolicy,
    type RetentionSettings,
    type SandboxSettings,
} from "@intentic/sandbox-contract";

// The public-office preset: the stricter settings an office under GDPR, KRI and the AI Act switches on, one item each,
// so the owner picks which. Never a default, and never applied without being named: most sandboxes are a developer's,
// and every value here takes something away from one.
//
// No item ever loosens anything. Where the sandbox is already stricter than the preset (an action already refused, a
// shorter retention, a longer audit trail) the item proposes what is there, so applying the whole preset to a stricter
// sandbox changes nothing.

export interface PresetState {
    readonly settings: SandboxSettings;
    readonly privacy: PrivacyShieldPolicy;
    // Whether a local named-entity model is installed; `names: model` without one is the dictionary alone.
    readonly nameModel: boolean;
}

// What a retention of zero means (keep forever) makes "shorter" the wrong comparison for it: zero is the longest.
export const PUBLIC_OFFICE_RETENTION: RetentionSettings = {
    transcriptDays: 90,
    restorePointDays: 30,
    privacyVaultDays: 90,
    cacheDays: 30,
    rawOutputDays: 30,
};

// Every outward action the agent can take that the action rules (SandboxSettings.actionRules) gate, as the outbound
// sniffer names it (activity/outbound.ts: discord, slack, telegram, whatsapp) and the subagent gate does
// (guard/actions.ts childSpawn). Writes only: a rule on `messages.read` would hold a bot reading its own channel. Email
// sending is the key the IMAP extension's sender consults (_extensions/imap/src/send.ts), which holds by default.
export const PUBLIC_OFFICE_ACTION_KEYS = [
    "discord.message.send",
    "discord.reaction.add",
    "slack.message.send",
    "slack.message.edit",
    "slack.reaction.add",
    "slack.reaction.remove",
    "telegram.message.send",
    "telegram.message.edit",
    "telegram.reaction.add",
    "whatsapp.message.send",
    "imap.message.send",
    "agents.spawn",
] as const;

// Work started from outside the sandbox: a webhook, a team-chat message, a visitor's web chat, a bug report. A clock
// (`schedule`) and the workspace's own files are the office's own doing, and `workflow` takes no hold (a CI runner
// would time out waiting).
export const PUBLIC_OFFICE_ADMISSION_KEYS = ["event", "listener", "webchat", "issues"] as const satisfies readonly (keyof AdmissionPolicy)[];

const STRICTNESS = { allow: 0, hold: 1, deny: 2 } as const satisfies Record<AdmissionRule, number>;
const stricter = (current: AdmissionRule, wanted: AdmissionRule): AdmissionRule => (STRICTNESS[current] >= STRICTNESS[wanted] ? current : wanted);

// The rule the gate would apply today: the exact key, else the provider's wildcard (guard/actions.ts outboundSend).
// `agents.spawn` has no wildcard of its own.
const effectiveActionRule = (rules: Readonly<Record<string, AdmissionRule>>, key: string): AdmissionRule | undefined => {
    if (rules[key] !== undefined) {
        return rules[key];
    }
    const provider = key.split(".")[0] ?? key;
    return key === "agents.spawn" ? undefined : rules[`${provider}.*`];
};

const shorterRetention = (current: number, wanted: number): number => (current > 0 && current < wanted ? current : wanted);

interface Draft {
    settings: SandboxSettings;
    privacy: PrivacyShieldPolicy;
}

interface PresetEntry {
    readonly id: string;
    readonly group: PresetGroup;
    readonly owner: boolean;
    readonly current: (state: PresetState) => PresetValue;
    readonly proposed: (state: PresetState) => PresetValue;
    readonly available?: (state: PresetState) => boolean;
    readonly write: (draft: Draft, value: PresetValue) => void;
}

const retentionEntry = (key: keyof RetentionSettings): PresetEntry => ({
    id: `retention.${key}`,
    group: "retention",
    owner: false,
    current: ({ settings }) => settings.retention[key],
    proposed: ({ settings }) => shorterRetention(settings.retention[key], PUBLIC_OFFICE_RETENTION[key]),
    write: (draft, value) => {
        draft.settings = { ...draft.settings, retention: { ...draft.settings.retention, [key]: Number(value) } };
    },
});

const actionEntry = (key: string): PresetEntry => ({
    id: `actionRules.${key}`,
    group: "actions",
    owner: false,
    current: ({ settings }) => effectiveActionRule(settings.actionRules, key) ?? null,
    proposed: ({ settings }) => stricter(effectiveActionRule(settings.actionRules, key) ?? "allow", "hold"),
    write: (draft, value) => {
        draft.settings = { ...draft.settings, actionRules: { ...draft.settings.actionRules, [key]: AdmissionRuleSchema.parse(value) } };
    },
});

const admissionEntry = (key: (typeof PUBLIC_OFFICE_ADMISSION_KEYS)[number]): PresetEntry => ({
    id: `admission.${key}`,
    group: "admission",
    owner: false,
    current: ({ settings }) => settings.admission[key],
    proposed: ({ settings }) => stricter(settings.admission[key], "hold"),
    write: (draft, value) => {
        draft.settings = { ...draft.settings, admission: { ...draft.settings.admission, [key]: AdmissionRuleSchema.parse(value) } };
    },
});

const ENTRIES: readonly PresetEntry[] = [
    // The shield first: it is what keeps a citizen's data from a provider outside the EEA.
    {
        id: "privacy.mode",
        group: "privacy",
        owner: true,
        current: ({ privacy }) => privacy.mode,
        proposed: () => "on",
        write: (draft) => {
            draft.privacy = { ...draft.privacy, mode: "on" };
        },
    },
    {
        id: "privacy.images",
        group: "privacy",
        owner: true,
        current: ({ privacy }) => privacy.images,
        proposed: () => "mask",
        write: (draft) => {
            draft.privacy = { ...draft.privacy, images: "mask" };
        },
    },
    {
        id: "privacy.names",
        group: "privacy",
        owner: true,
        current: ({ privacy }) => privacy.names,
        proposed: () => "model",
        // Without the model, `model` finds names by the dictionary alone, so offering it would promise what it can't do.
        available: ({ nameModel }) => nameModel,
        write: (draft) => {
            draft.privacy = { ...draft.privacy, names: "model" };
        },
    },
    retentionEntry("transcriptDays"),
    retentionEntry("restorePointDays"),
    retentionEntry("privacyVaultDays"),
    retentionEntry("cacheDays"),
    retentionEntry("rawOutputDays"),
    {
        id: "audit.retentionDays",
        group: "audit",
        owner: false,
        current: ({ settings }) => settings.audit.retentionDays,
        // Longer is the stricter direction for a log: KRI asks for two years, and more is never trimmed.
        proposed: ({ settings }) => Math.max(settings.audit.retentionDays, AUDIT_RETENTION_DAYS_PUBLIC_OFFICE),
        write: (draft, value) => {
            draft.settings = { ...draft.settings, audit: { ...draft.settings.audit, retentionDays: Number(value) } };
        },
    },
    {
        id: "audit.recordReads",
        group: "audit",
        owner: false,
        current: ({ settings }) => settings.audit.recordReads,
        proposed: () => true,
        write: (draft) => {
            draft.settings = { ...draft.settings, audit: { ...draft.settings.audit, recordReads: true } };
        },
    },
    {
        id: "productAnalytics",
        group: "analytics",
        owner: false,
        current: ({ settings }) => settings.productAnalytics,
        proposed: () => false,
        write: (draft) => {
            draft.settings = { ...draft.settings, productAnalytics: false };
        },
    },
    {
        id: "aiNotice.show",
        group: "notice",
        owner: false,
        current: ({ settings }) => settings.aiNotice.show,
        proposed: () => true,
        write: (draft) => {
            draft.settings = { ...draft.settings, aiNotice: { ...draft.settings.aiNotice, show: true } };
        },
    },
    ...PUBLIC_OFFICE_ACTION_KEYS.map(actionEntry),
    ...PUBLIC_OFFICE_ADMISSION_KEYS.map(admissionEntry),
    {
        id: "commandJudge",
        group: "judge",
        owner: false,
        current: ({ settings }) => settings.commandJudge,
        proposed: () => "on",
        write: (draft) => {
            draft.settings = { ...draft.settings, commandJudge: "on" };
        },
    },
];

export const PRESET_ITEM_IDS: readonly string[] = ENTRIES.map((entry) => entry.id);

const itemOf = (entry: PresetEntry, state: PresetState): PresetItem => {
    const current = entry.current(state);
    const proposed = entry.proposed(state);
    return {
        id: entry.id,
        group: entry.group,
        current,
        proposed,
        changes: current !== proposed,
        available: entry.available?.(state) ?? true,
        owner: entry.owner,
    };
};

export const presetPreview = (state: PresetState): PresetItem[] => ENTRIES.map((entry) => itemOf(entry, state));

export interface PresetOutcome extends PresetApplyResult {
    readonly settings: SandboxSettings;
    readonly privacy: PrivacyShieldPolicy;
    readonly settingsChanged: boolean;
    readonly privacyChanged: boolean;
}

// The named items applied to a copy of the state, the rest left alone. `owner` says whether the caller may change the
// privacy shield; the route floors at the owner, so a false here is a program's call (a test, a future maintainer door).
export const applyPreset = (state: PresetState, ids: readonly string[], owner: boolean): PresetOutcome => {
    const draft: Draft = { settings: state.settings, privacy: state.privacy };
    const applied: string[] = [];
    const skipped: PresetApplyResult["skipped"] = [];
    let settingsChanged = false;
    let privacyChanged = false;
    for (const id of new Set(ids)) {
        const entry = ENTRIES.find((candidate) => candidate.id === id);
        if (entry === undefined) {
            skipped.push({ id, reason: "unknown" });
            continue;
        }
        const item = itemOf(entry, state);
        if (!item.available) {
            skipped.push({ id, reason: "unavailable" });
        } else if (entry.owner && !owner) {
            skipped.push({ id, reason: "owner" });
        } else if (!item.changes) {
            skipped.push({ id, reason: "unchanged" });
        } else {
            entry.write(draft, item.proposed);
            applied.push(id);
            if (entry.group === "privacy") {
                privacyChanged = true;
            } else {
                settingsChanged = true;
            }
        }
    }
    return { applied, skipped, settings: draft.settings, privacy: draft.privacy, settingsChanged, privacyChanged };
};
