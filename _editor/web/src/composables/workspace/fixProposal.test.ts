import type { CommandRun, PushRun } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { checkFixPrompt, checkOutcome, outcomeSummary, pushFixPrompt, refusalSummary } from "./fixProposal";

/* THE TWO HALVES OF THE PUSH FLOW SAY THE SAME THINGS THE SAME WAY. Every case here runs the check's words
 * and the push's words side by side, so a sentence or a prompt shape that changes for one and not the other
 * fails here, by name, before it reaches a card. */

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

test(`the heading over a settled run is the same vocabulary for the check and the push`, () => {
    const pairs: readonly (readonly [Partial<CommandRun>, string])[] = [
        [{ status: `failed` }, `failed`],
        [{ status: `failed`, timedOut: true }, `timed out`],
        [{ status: `error` }, `couldn't run`],
        [{ status: `cancelled` }, `stopped`],
        [{ status: `idle` }, `didn't run`],
    ];
    for (const [over, ending] of pairs) {
        expect(checkOutcome({ ...check, ...over })).toBe(`Checks ${ending}`);
    }
});

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
    // git's line already ends in a full stop, and the sentence around it must not add a second.
    expect(refusalSummary({ ...push, refusedBy: `transport`, reason: `fatal: Could not read from remote repository.` })).toBe(
        `never reached the remote: fatal: Could not read from remote repository.`,
    );
    // A push that never ran carries git's situation rather than its words.
    expect(refusalSummary({ ...push, status: `error`, reason: `no remote configured`, output: `` })).toBe(`could not run: no remote configured.`);
    // The rest is the check's own vocabulary, unchanged.
    expect(refusalSummary({ ...push, timedOut: true })).toBe(outcomeSummary({ ...push, timedOut: true }));
    expect(refusalSummary({ ...push, status: `cancelled` })).toBe(outcomeSummary({ ...push, status: `cancelled` }));
});

test(`the check's proposal states what ran, what to do, and quotes the tail in a fence`, () => {
    expect(checkFixPrompt(check)).toBe(
        [
            "`pnpm check` failed (exit 1). This is what blocks the push, and it is what CI would have said a few minutes later.",
            "Find the cause and fix it, then re-run `pnpm check` yourself to confirm.",
            "Its output (tail):\n\n```\nFAIL src/a.test.ts\n  ✗ adds\n```",
        ].join(`\n\n`),
    );
});

test(`the push's proposal has the check's shape with the hook's situation in it`, () => {
    expect(pushFixPrompt([push])).toBe(
        [
            "`git push origin main` in intentic was refused by the repository's own pre-push hook (exit 1). The hook is the workspace's gate, so this is what blocks the push, and it is what CI would have said a few minutes later.",
            "Find the cause and fix it, then confirm the hook passes: `git push --dry-run` in intentic runs it without sending anything.",
            "Its output (tail):\n\n```\nverify-push: typecheck failed; the push does not go\nerror: failed to push some refs to 'origin'\n```",
        ].join(`\n\n`),
    );
});

test(`both proposals drop the fence when there is nothing to quote, and both name the CI round-trip`, () => {
    const quiet = checkFixPrompt({ ...check, output: `  \n` });
    const quietPush = pushFixPrompt([{ ...push, output: `` }]);
    for (const prompt of [quiet, quietPush]) {
        expect(prompt).not.toContain("```");
        expect(prompt).toContain(`it is what CI would have said a few minutes later.`);
    }
    // A killed run says so instead of an exit code, and asks for the hang to be found.
    expect(checkFixPrompt({ ...check, timedOut: true, output: `` })).toBe(
        [
            "`pnpm check` did not finish, it hit its time limit and was killed. Treat that as a failure: something hangs, and finding what is part of the fix. This is what blocks the push, and it is what CI would have said a few minutes later.",
            "Find the cause and fix it, then re-run `pnpm check` yourself to confirm.",
        ].join(`\n\n`),
    );
});

test(`several repos refused in one push are several sections of one turn`, () => {
    const other: PushRun = { ...push, repo: `docs`, command: `git push -u origin main`, output: `docs: lint failed` };
    const prompt = pushFixPrompt([push, other]);
    expect(prompt.split(`\n\n---\n\n`)).toEqual([pushFixPrompt([push]), pushFixPrompt([other])]);
});
