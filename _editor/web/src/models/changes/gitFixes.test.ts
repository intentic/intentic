import type { PushRun } from "@intentic/sandbox-contract/schemas/git/git";
import { needsPullRequest, operationFix, pushFix } from "./gitFixes";

const ruleRefusal: PushRun = {
    status: `failed`,
    repo: `registry`,
    command: `git push origin main`,
    exitCode: 1,
    output: [
        `remote: error: GH013: Repository rule violations found for refs/heads/main.`,
        `remote: - Changes must be made through a pull request.`,
        ` ! [remote rejected] main -> main (push declined due to repository rule violations)`,
        `error: failed to push some refs to 'ssh://github.com/intentic/registry'`,
    ].join(`\n`),
    reason: `error: failed to push some refs to 'ssh://github.com/intentic/registry'`,
    refusedBy: `remote`,
};

test(`a branch that only takes pull requests is asked for one, never worked around`, () => {
    const fix = pushFix(`Push failed in registry`, ruleRefusal);

    expect(needsPullRequest(ruleRefusal)).toBe(true);
    expect(fix.tree).toBe(`shared`);
    expect(fix.facts).toEqual([`The remote takes changes on this branch only through a pull request.`]);
    expect(fix.goal).toContain(`open a pull request`);
    expect(fix.goal).toContain(`Do not try to get around the rule`);
});

test(`any other refused push is asked to deal with the cause, its hook's findings first`, () => {
    const hook: PushRun = { ...ruleRefusal, output: `verify-push: typecheck failed`, refusedBy: `hook` };

    expect(needsPullRequest(hook)).toBe(false);
    expect(pushFix(`Push failed`, hook).goal).toContain(`fix what the hook found`);
});

test(`an operation left in progress names its conflicted files`, () => {
    const fix = operationFix({ repo: `root`, title: `A rebase is in progress`, operation: `rebase`, conflicted: [`a.ts`, `b.ts`] });

    expect(fix.facts).toEqual([`A rebase is in progress.`, "Conflicted files: `a.ts`, `b.ts`"]);
    expect(fix.goal).toContain(`continue until the rebase is done`);
});
