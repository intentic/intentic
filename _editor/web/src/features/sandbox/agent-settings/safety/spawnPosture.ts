import type { AdmissionRule } from "@intentic/sandbox-contract";
import type { PickerOption } from "@intentic/ui";

// Whether a turn may start child agents, keyed by `agents.spawn` in the open `actionRules` record shared with
// the outbound sniffer's provider rules. A settings patch must merge into it, not replace it, or unrelated rules
// are silently deleted.

// Four postures; `default` is a real choice, not an absent one — an unset key holds a spawn after outside
// content, unlike an explicit `allow`.
export type Posture = "default" | AdmissionRule;

export const SPAWN_KEY = `agents.spawn`;

// Four real answers, not a boolean: `hold` lets a spawn wait on the owner, and `default` differs from `allow`.
export const POSTURES: readonly PickerOption<Posture>[] = [
    { value: `default`, label: `Default`, icon: `circle`, description: `runs, asks after outside content` },
    { value: `allow`, label: `Always allow`, icon: `check-circle` },
    { value: `hold`, label: `Ask me`, icon: `lock` },
    { value: `deny`, label: `Never`, icon: `times` },
];

export const postureOf = (rules: Readonly<Record<string, AdmissionRule>>): Posture => rules[SPAWN_KEY] ?? `default`;

// Returning to `default` deletes the key rather than writing it back; an explicit rule would be a weaker setting
// than the fallback it replaces.
export const withPosture = (rules: Readonly<Record<string, AdmissionRule>>, next: Posture): Record<string, AdmissionRule> => {
    const actionRules: Record<string, AdmissionRule> = { ...rules };
    if (next === `default`) {
        delete actionRules[SPAWN_KEY];
    } else {
        actionRules[SPAWN_KEY] = next;
    }
    return actionRules;
};
