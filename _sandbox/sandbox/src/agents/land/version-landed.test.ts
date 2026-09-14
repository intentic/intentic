import type { Rule } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { versionRuleOf } from "./version-landed.js";

const rule = (over: Partial<Rule> & Pick<Rule, "id" | "moment" | "action">): Rule => ({ label: over.id, enabled: true, ...over });

const version = (id: string, over: Partial<Rule> = {}): Rule =>
    rule({ id, moment: "agent.landed", action: { kind: "builtin", name: "version-landed" }, ...over });

describe(`the version rule`, () => {
    test(`stands only as the versioner built-in at the landed moment`, () => {
        expect(versionRuleOf([version(`auto-version`)])?.id).toBe(`auto-version`);
        // The same built-in name at another moment is not this rule; the schema refuses it at save, and this is the
        // reader's own half of that refusal.
        expect(versionRuleOf([rule({ id: `x`, moment: `turn.ending`, action: { kind: `builtin`, name: `version-landed` } })])).toBeUndefined();
        expect(versionRuleOf([rule({ id: `land`, moment: `agent.finished`, action: { kind: `verdict`, verdict: `allow` } })])).toBeUndefined();
    });

    test(`a switched-off rule leaves every commit to the owner`, () => {
        expect(versionRuleOf([version(`auto-version`, { enabled: false })])).toBeUndefined();
        expect(versionRuleOf([])).toBeUndefined();
    });
});
