import { audienceOfMode, effectiveAudience, handsOffChanges, handsOffRules, MANAGED_RULE_IDS, managedRule } from "./sandbox-mode.js";
import { type Rule, RuleSchema, SandboxSettingsSchema } from "./settings.js";

// A hands-off sandbox owns three rules and leaves every other one alone: the owner's hold still decides first, a managed
// rule they narrowed or switched off stands again where it was, a missing one goes at the end, and a list that already
// is hands-off comes back as the very same array.

const hold: Rule = RuleSchema.parse({
    id: "hold-payments",
    label: "Hold work on payments",
    moment: "agent.finished",
    when: { paths: ["payments/"] },
    action: { kind: "verdict", verdict: "hold" },
});

const ids = (rules: readonly Rule[]): string[] => rules.map((rule) => rule.id);

test("an empty list gains the three rules, in the order they act", () => {
    expect(ids(handsOffRules([]))).toEqual(["auto-land", "auto-version", "auto-push"]);
    expect(handsOffChanges([])).toEqual(["land", "version", "push"]);
});

test("an owner's hold stays ahead of the land, so it still decides first", () => {
    const rules = handsOffRules([hold]);
    expect(ids(rules)).toEqual(["hold-payments", "auto-land", "auto-version", "auto-push"]);
    expect(rules[0]).toBe(hold);
});

test("a managed rule switched off or narrowed stands again where it was", () => {
    const off = { ...managedRule("land"), enabled: false };
    const narrowed = { ...managedRule("version"), when: { repo: "site" } };
    const rules = handsOffRules([off, hold, narrowed]);

    expect(ids(rules)).toEqual(["auto-land", "hold-payments", "auto-version", "auto-push"]);
    expect(rules[0]).toEqual(managedRule("land"));
    expect(rules[2]).toEqual(managedRule("version"));
    expect(handsOffChanges([off, hold, narrowed])).toEqual(["land", "version", "push"]);
});

test("a list that already is hands-off comes back as the same array", () => {
    const already = handsOffRules([hold]);
    expect(handsOffRules(already)).toBe(already);
    expect(handsOffChanges(already)).toEqual([]);
});

test("every managed rule is one the settings take", () => {
    const rules = handsOffRules([]);
    expect(SandboxSettingsSchema.parse({ mode: "hands-off", rules }).rules).toEqual(rules);
    expect(ids(rules)).toEqual(Object.values(MANAGED_RULE_IDS));
});

test("a managed rule handed out is a copy", () => {
    const first = managedRule("push");
    first.enabled = false;
    expect(managedRule("push").enabled).toBe(true);
});

test("the words follow the mode unless a person chose their own", () => {
    expect(audienceOfMode("hands-off")).toBe("maker");
    expect(audienceOfMode("hands-on")).toBe("developer");
    expect(effectiveAudience("hands-off", undefined)).toBe("maker");
    expect(effectiveAudience("hands-off", "developer")).toBe("developer");
    expect(effectiveAudience("hands-on", "maker")).toBe("maker");
});

test("a sandbox that never said runs hands-on", () => {
    expect(SandboxSettingsSchema.parse({}).mode).toBe("hands-on");
});
