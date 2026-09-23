import type { CommandRun, PushRun } from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";
import { fixSignature, outcomeSummary, pushFixPrompt, refusalSummary } from "./fixProposal";

const check: CommandRun = { status: `failed`, command: `pnpm check`, exitCode: 1, output: `FAIL src/a.test.ts\n  ✗ adds` };
const push: PushRun = {
    status: `failed`,
    repo: `intentic`,
    command: `git push origin main`,
    exitCode: 1,
    output: `verify-push: typecheck failed; the push does not go\nerror: failed to push some refs to 'origin'`,
    reason: `error: failed to push some refs to 'origin'`,
    refusedBy: `hook`,
};

test(`the line under the command names how the run ended, and says nothing for a plain failure the evidence explains`, () => {
    expect(outcomeSummary(check)).toBe(``);
    expect(outcomeSummary({ ...check, timedOut: true })).toBe(`never finished: it hit its time limit and was killed.`);
    expect(outcomeSummary({ ...check, status: `error` })).toBe(`could not run at all.`);
    expect(outcomeSummary({ ...check, status: `cancelled` })).toBe(`was stopped before it finished.`);
});

test(`a push's line says who refused it, in the words that decide what the owner can do`, () => {
    expect(refusalSummary(push)).toBe(`was refused by this repository's pre-push hook.`);
    expect(refusalSummary({ ...push, refusedBy: `remote`, reason: `! [rejected] main -> main (fetch first)` })).toBe(
        `was rejected by the remote: ! [rejected] main -> main (fetch first).`,
    );
    // git's line already ends in a full stop; the sentence around it must not add a second.
    expect(refusalSummary({ ...push, refusedBy: `transport`, reason: `fatal: Could not read from remote repository.` })).toBe(
        `never reached the remote: fatal: Could not read from remote repository.`,
    );
    // A push that never ran carries git's situation rather than its words.
    expect(refusalSummary({ ...push, status: `error`, reason: `no remote configured`, output: `` })).toBe(`could not run: no remote configured.`);
    // The rest is how any run ended, unchanged.
    expect(refusalSummary({ ...push, timedOut: true })).toBe(outcomeSummary({ ...push, timedOut: true }));
    expect(refusalSummary({ ...push, status: `cancelled` })).toBe(outcomeSummary({ ...push, status: `cancelled` }));
});

test(`the proposal states what the hook refused, what to do, and quotes the tail in a fence`, () => {
    expect(pushFixPrompt([push])).toBe(
        [
            "`git push origin main` in intentic was refused by the repository's own pre-push hook (exit 1). The hook is the workspace's gate, so this is what blocks the push, and it is what CI would have said a few minutes later.",
            "Find the cause and fix it, then confirm the hook passes: `git push --dry-run` in intentic runs it without sending anything.",
            "Its output (tail):\n\n```\nverify-push: typecheck failed; the push does not go\nerror: failed to push some refs to 'origin'\n```",
        ].join(`\n\n`),
    );
});

test(`the proposal drops the fence when there is nothing to quote, and still names the CI round-trip`, () => {
    const quiet = pushFixPrompt([{ ...push, output: `` }]);
    expect(quiet).not.toContain("```");
    expect(quiet).toContain(`it is what CI would have said a few minutes later.`);
});

test(`several repos refused in one push are several sections of one turn`, () => {
    const other: PushRun = { ...push, repo: `docs`, command: `git push -u origin main`, output: `docs: lint failed` };
    const prompt = pushFixPrompt([push, other]);
    expect(prompt.split(`\n\n---\n\n`)).toEqual([pushFixPrompt([push]), pushFixPrompt([other])]);
});

// The signature must survive parts of a run that change while the breakage doesn't, and change when the
// breakage does. Each case below tests one of those properties.

// The exact shape lib/steps.mjs prints; fixSignature reads from this.
const digest = (steps: readonly string[], seconds: number): string =>
    [
        `FAIL src/a.test.ts`,
        `  ✗ adds two numbers`,
        ``,
        `verify-push: ${steps.length} of 6 steps failed in ${seconds}s: ${steps.join(`, `)}`,
        ...steps.map((step) => `  ✗ ${step}  exit 1 · pnpm ${step}`),
    ].join(`\n`);

test(`the signature is the failed steps and the files they name, and survives what changes between two runs of one breakage`, () => {
    const first = fixSignature(digest([`checkout gates`, `lint`], 12));
    expect(first).toBe(`checkout gates,lint|src/a.test.ts`);
    // A second run of the same broken tree: slower, and the digest lists the same two the other way round.
    expect(fixSignature(digest([`lint`, `checkout gates`], 340))).toBe(first);
});

// A range differs on every push; the gate itself is what's the same.
test(`what a step name carries in parentheses is not part of the signature`, () => {
    expect(fixSignature(digest([`assertion ratchet (a1b2c3d..e4f5g6h)`], 9))).toBe(fixSignature(digest([`assertion ratchet (99f00aa..12b34cd)`], 9)));
    expect(fixSignature(digest([`assertion ratchet (a1b2c3d..e4f5g6h)`], 9))).toBe(`assertion ratchet|src/a.test.ts`);
});

// Four days of unrelated tidy failures once shared one id and were told to carry on from each other's attempts.
test(`the same gate red on other files is another failure, and the same files at other lines are this one`, () => {
    const on = (anchor: string): string => fixSignature(`✗ paths (path-literals.mjs)\n${anchor}  spells a root\nverify-push: 1 of 5 steps failed in 3s: tidiness`);
    expect(on(`_sandbox/sandbox/src/a.ts:32`)).toBe(`tidiness|_sandbox/sandbox/src/a.ts`);
    expect(on(`_sandbox/sandbox/src/a.ts:40`)).toBe(on(`_sandbox/sandbox/src/a.ts:32`));
    expect(on(`_tools/scripts/repair-transcripts.mjs:9`)).not.toBe(on(`_sandbox/sandbox/src/a.ts:32`));
});

// A grown failure is not the one the agent is already on.
test(`a different set of failed steps is a different signature`, () => {
    expect(fixSignature(digest([`checkout gates`], 12))).not.toBe(fixSignature(digest([`checkout gates`, `lint`], 12)));
});

// A run that ended where it stood prints no digest; the last line is the reason, with its numbers blanked so
// one exit code isn't two failures.
test(`a run with no digest is keyed by its last line, with the numbers blanked`, () => {
    expect(fixSignature(`verify-push: pnpm typecheck failed (exit 1); the push does not go`)).toBe(
        fixSignature(`verify-push: pnpm typecheck failed (exit 2); the push does not go`),
    );
    expect(fixSignature(check.output)).toBe(`✗ adds`);
    expect(fixSignature(``)).toBe(``);
});
