import type { AdmissionRule } from "@intentic/sandbox-contract";
import type { PickerOption } from "@intentic/ui";

/* WHETHER A TURN MAY START AGENTS OF ITS OWN, as a value rather than as a component's handler.
 *
 * It is one entry in `actionRules`, and `actionRules` is an OPEN RECORD: it also holds the outbound sniffer's
 * `<provider>.<type>` rules, written by a different page entirely. A settings patch takes the field's whole new
 * value, so the only safe write is a merge — replacing the object with `{ "agents.spawn": … }` would delete
 * every send rule the owner has, silently, from a row that says nothing about sending.
 *
 * It lives here rather than in the row because that is the part worth pinning: the row is a picker and four
 * labels, while this is the part whose bug costs someone a rule they cannot see from the screen that ate it. */

// Four postures, and Default is one of them rather than the absence of a choice: an unset key HOLDS a spawn from
// a turn that has taken in outside content, so an explicit `allow` is a different setting from no setting.
export type Posture = "default" | AdmissionRule;

export const SPAWN_KEY = `agents.spawn`;

/* FOUR POSTURES, AND IT IS A PICKER RATHER THAN A TOGGLE, which is the one thing about this control that looks
 * like an oversight and is not. The safety policy on the tab next door replaced a rulebook of switches with a
 * document because a REGEX was reaching the verdicts there, and no arrangement of switches fixes a classifier
 * that cannot tell `echo "rm -rf /"` from a delete. Nothing of the kind is happening here: "may this turn start
 * a child agent" is a fact about the call, not a guess about what a string means, so a switch answers it
 * exactly and prose would only add a way to be misread.
 *
 * The pressure this list is under is the opposite one — collapsing to a boolean, which would read as a tidy-up
 * and would quietly cost two of the four answers: `hold`, the only one that lets a spawn happen with the owner
 * in the loop, and `default`, which is not `allow` (see below). The list lives here, beside the write, so a test
 * can hold the shape rather than the row's markup. */
export const POSTURES: readonly PickerOption<Posture>[] = [
    { value: `default`, label: `Default`, icon: `circle`, description: `runs, asks after outside content` },
    { value: `allow`, label: `Always allow`, icon: `check-circle` },
    { value: `hold`, label: `Ask me`, icon: `lock` },
    { value: `deny`, label: `Never`, icon: `times` },
];

export const postureOf = (rules: Readonly<Record<string, AdmissionRule>>): Posture => rules[SPAWN_KEY] ?? `default`;

// Returning to Default DELETES the key rather than writing one, because an explicit rule spelling out the
// fallback would be a different, weaker setting sitting where the fallback used to be.
export const withPosture = (rules: Readonly<Record<string, AdmissionRule>>, next: Posture): Record<string, AdmissionRule> => {
    const actionRules: Record<string, AdmissionRule> = { ...rules };
    if (next === `default`) {
        delete actionRules[SPAWN_KEY];
    } else {
        actionRules[SPAWN_KEY] = next;
    }
    return actionRules;
};
