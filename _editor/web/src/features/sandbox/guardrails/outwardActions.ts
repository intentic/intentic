import type { AdmissionPolicy, AdmissionRule } from "@intentic/sandbox-contract/schemas/command-admission";
import { effectiveActionRule, OUTWARD_ACTION_KEYS, outwardActionService } from "@intentic/sandbox-contract/schemas/data-protection";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import type { PickerOption } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { SPAWN_KEY } from "./spawnPosture";

// What the agent may do out in the world without a person saying yes (`settings.actionRules`), one row per service, and
// whether work started from outside may run at all (`settings.admission`). Both could only be tightened through the
// public-office preset on Data protection until 2026-10-16; Guardrails is where they are set now.

// The extension that brings each service's actions: a service is offered while it is switched on, or while a rule for it
// is still stored (a rule outlives the extension it was written for, and the gate would still read it).
const SERVICE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
    [`discord`, `intentic.discord`],
    [`slack`, `intentic.slack`],
    [`telegram`, `intentic.telegram`],
    [`whatsapp`, `intentic.whatsapp`],
    [`imap`, `intentic.imap`],
    [`microsoft365`, `intentic.microsoft-365`],
    [`ezdrp`, `intentic.e-urzad`],
    [`edoreczenia`, `intentic.e-urzad`],
]);

type ActionRules = SandboxSettings["actionRules"];

export interface ServiceRow {
    readonly service: string;
    /** The action keys the gate consults for it, in the contract's order. */
    readonly keys: readonly string[];
    /** The one rule every key resolves to, or undefined while they differ. */
    readonly rule: AdmissionRule | undefined;
}

// No rule is allowed, for every gate here; only the subagent gate reads an absent rule differently, and it is not a row.
const ruleOf = (rules: Readonly<ActionRules>, key: string): AdmissionRule => effectiveActionRule(rules, key) ?? `allow`;

export const serviceRows = (rules: Readonly<ActionRules>, enabled: ReadonlySet<string>): readonly ServiceRow[] => {
    const byService = new Map<string, string[]>();
    for (const key of OUTWARD_ACTION_KEYS) {
        if (key === SPAWN_KEY) {
            continue;
        }
        const service = outwardActionService(key);
        byService.set(service, [...(byService.get(service) ?? []), key]);
    }
    const stored = new Set(Object.keys(rules).map(outwardActionService));
    return [...byService]
        .filter(([service]) => enabled.has(SERVICE_EXTENSIONS.get(service) ?? ``) || stored.has(service))
        .map(([service, keys]) => {
            const found = new Set(keys.map((key) => ruleOf(rules, key)));
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
export const actionRules = (rules: Readonly<ActionRules>, row: Pick<ServiceRow, "keys">): readonly { key: string; rule: AdmissionRule }[] =>
    row.keys.map((key) => ({ key, rule: ruleOf(rules, key) }));

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
