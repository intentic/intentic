import type { AdmissionPolicy, AdmissionRule } from "@intentic/sandbox-contract/schemas/command-admission";
import { effectiveActionRule, type OutwardAction, outwardActionService } from "@intentic/sandbox-contract/schemas/data-protection";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import type { PickerOption } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { SPAWN_KEY } from "./spawnPosture";

// What the agent may do out in the world without a person saying yes (`settings.actionRules`), one row per service, and
// whether work started from outside may run at all (`settings.admission`). Both could only be tightened through the
// public-office preset on Data protection until 2026-10-16; Guardrails is where they are set now.

// (2026-11-25) The actions a daemon from before `GET /settings/outward-actions` gated, by the extension that brings each
// service: that daemon held its own fixed list and offered a service while the extension was switched on. Only for such
// a daemon (docs/architecture/app-plane.md, older daemons); a newer one serves what its enabled extensions declare.
const LEGACY_ACTIONS: readonly (readonly [extension: string, keys: readonly string[]])[] = [
    [`intentic.discord`, [`discord.message.send`, `discord.reaction.add`]],
    [`intentic.slack`, [`slack.message.send`, `slack.message.edit`, `slack.reaction.add`, `slack.reaction.remove`]],
    [`intentic.telegram`, [`telegram.message.send`, `telegram.message.edit`, `telegram.reaction.add`]],
    [`intentic.whatsapp`, [`whatsapp.message.send`]],
    [`intentic.imap`, [`imap.message.send`]],
    [`intentic.microsoft-365`, [`microsoft365.mail.send`, `microsoft365.calendar.write`, `microsoft365.files.upload`]],
    [
        `intentic.e-urzad`,
        [
            `ezdrp.document.register-incoming`,
            `ezdrp.document.register-outgoing`,
            `ezdrp.case.attach-draft`,
            `edoreczenia.delivery.send`,
            `edoreczenia.delivery.open`,
        ],
    ],
];

/** What an older daemon offered: its fixed list, for the extensions switched on. */
export const legacyOutwardActions = (enabled: ReadonlySet<string>): readonly OutwardAction[] =>
    LEGACY_ACTIONS.flatMap(([extension, keys]) => (enabled.has(extension) ? keys.map((key) => ({ key, extension })) : []));

type ActionRules = SandboxSettings["actionRules"];

export interface ServiceRow {
    readonly service: string;
    /** The action keys the gate consults for it, in the order they were declared. */
    readonly keys: readonly string[];
    /** The one rule every key resolves to, or undefined while they differ. */
    readonly rule: AdmissionRule | undefined;
}

// No rule is allowed, unless the action's declaration says its tool holds it until the owner writes one (`unruled`, the
// mail senders: 2026-11-26, when their gate moved into the daemon); the subagent gate reads an absent rule differently,
// and it is not a row.
const ruleOf = (rules: Readonly<ActionRules>, key: string, offered: readonly OutwardAction[]): AdmissionRule =>
    effectiveActionRule(rules, key) ?? offered.find((action) => action.key === key)?.unruled ?? `allow`;

// Starting subagents (`agents.spawn`, and a provider's own `agents.spawn.<provider>`) has a posture of its own, never a row.
const SPAWN_SERVICE = outwardActionService(SPAWN_KEY);

const grouped = (keys: Iterable<string>): Map<string, string[]> => {
    const byService = new Map<string, string[]>();
    for (const key of keys) {
        const service = outwardActionService(key);
        const held = byService.get(service) ?? [];
        if (service !== SPAWN_SERVICE && !held.includes(key)) {
            byService.set(service, [...held, key]);
        }
    }
    return byService;
};

/**
 * One row per service the enabled extensions declare actions for (`offered`, as the daemon serves them), then one per
 * service a stored rule still names: a rule outlives the extension it was written for, and the gate still reads it, so
 * that row covers the keys the rules name.
 */
export const serviceRows = (rules: Readonly<ActionRules>, offered: readonly OutwardAction[]): readonly ServiceRow[] => {
    const byService = grouped(offered.map((action) => action.key));
    for (const [service, keys] of grouped(Object.keys(rules))) {
        if (!byService.has(service)) {
            byService.set(service, keys);
        }
    }
    return [...byService].map(([service, keys]) => {
        const found = new Set(keys.map((key) => ruleOf(rules, key, offered)));
        return { service, keys, rule: found.size === 1 ? [...found][0] : undefined };
    });
};

/** Each of the service's actions under one rule, written to its own key: a `<service>.*` wildcard would also catch reads. */
export const withServiceRule = (
    rules: Readonly<ActionRules>,
    row: Pick<ServiceRow, "keys">,
    rule: AdmissionRule,
): ActionRules => ({ ...rules, ...Object.fromEntries(row.keys.map((key) => [key, rule])) });

/** How each of a mixed service's actions stands, for the line under its row. */
export const actionRules = (
    rules: Readonly<ActionRules>,
    row: Pick<ServiceRow, "keys">,
    offered: readonly OutwardAction[] = [],
): readonly { key: string; rule: AdmissionRule }[] => row.keys.map((key) => ({ key, rule: ruleOf(rules, key, offered) }));

export const ruleOptions = (): readonly PickerOption<AdmissionRule>[] => [
    { value: `allow`, label: t(`sandbox.guardrails.rule.allow`), icon: `check-circle` },
    { value: `hold`, label: t(`sandbox.guardrails.rule.hold`), icon: `lock` },
    { value: `deny`, label: t(`sandbox.guardrails.rule.deny`), icon: `times` },
];

// Work started from outside, the ones a stranger can reach without the owner wiring anything first, then the ones the
// owner set up, then the box's own: a clock, the workspace's own events, and a CI workflow, which takes no hold (a runner
// would time out waiting).
export const ADMISSION_KEYS = [`webchat`, `issues`, `listener`, `event`, `schedule`, `workspace`, `workflow`] as const satisfies readonly (keyof AdmissionPolicy)[];
export type AdmissionKey = (typeof ADMISSION_KEYS)[number];

export const admissionOptions = (key: AdmissionKey): readonly PickerOption<AdmissionRule>[] =>
    key === `workflow` ? ruleOptions().filter((option) => option.value !== `hold`) : ruleOptions();
