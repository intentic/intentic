import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Rule } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { Services } from "../../composition.js";
import { settleLanding, versionRuleOf } from "./version-landed.js";
import { isolatedAgent } from "../../testing.js";

const describeLanding = mock<() => Promise<void>>();
mock.module("./landed-subject.js", () => ({ describeLanding: () => describeLanding() }));
const commitOnly = mock<(dir: string, paths: readonly string[], subject: string) => Promise<boolean>>(async () => true);
mock.module("../../git/changes/changes-index.js", () => ({
    commitOnly: (dir: string, paths: readonly string[], subject: string) => commitOnly(dir, paths, subject),
}));
mock.module("../../git/remote/root-repo.js", () => ({ commitWorktreeRemainder: async () => false }));

const rule = (over: Partial<Rule> & Pick<Rule, "id" | "moment" | "action">): Rule => ({ label: over.id, enabled: true, ...over });

const version = (id: string, over: Partial<Rule> = {}): Rule =>
    rule({ id, moment: "agent.landed", action: { kind: "builtin", name: "version-landed" }, ...over });

const servicesWith = (rules: readonly Rule[], landedSubject?: string): Services =>
    unstubbed<Services>("services", {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => ({ rules }) as never }),
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () =>
                isolatedAgent([{ repo: "root", base: "a".repeat(40) }], {
                    social: { title: { text: "Recent commits", source: "derived" }, reactions: [] },
                    landing: landedSubject === undefined ? {} : { message: { subject: landedSubject } },
                }),
        }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {
            mainDir: () => WORKSPACE_ROOT,
            withRepoLock: async (_repo, run) => run(),
        }),
        agentOrigins: unstubbed<Services["agentOrigins"]>("agentOrigins", { forRepo: async () => ({ "a.ts": ["c1"] }) }),
        ruleFirings: unstubbed<Services["ruleFirings"]>("ruleFirings", { stamp: async () => undefined }),
        logger: unstubbed<Services["logger"]>("logger", { debug: () => undefined, info: () => undefined, warn: () => undefined }),
    });

beforeEach(() => {
    describeLanding.mockReset();
    describeLanding.mockResolvedValue(undefined);
    commitOnly.mockClear();
});

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

describe(`settling a landing`, () => {
    test(`commits the claim under the subject drafted for it`, async () => {
        await settleLanding(servicesWith([version(`auto-version`)], `fix: cascading markers`), `c1`);
        expect(commitOnly).toHaveBeenCalledWith(WORKSPACE_ROOT, [`a.ts`], `fix: cascading markers`);
    });

    // The report already tells the owner the draft failed; the landing must still reach history.
    test(`a failed draft still commits, under the conversation's title`, async () => {
        describeLanding.mockRejectedValue(new Error(`every model set for this job names an account this sandbox no longer has`));
        await settleLanding(servicesWith([version(`auto-version`)]), `c1`);
        expect(commitOnly).toHaveBeenCalledWith(WORKSPACE_ROOT, [`a.ts`], `Agent: Recent commits`);
    });

    test(`without the rule the subject is still drafted for the chip, and nothing is committed`, async () => {
        await settleLanding(servicesWith([], `fix: cascading markers`), `c1`);
        expect(describeLanding).toHaveBeenCalledTimes(1);
        expect(commitOnly).not.toHaveBeenCalled();
    });
});
