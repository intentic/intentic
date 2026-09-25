import type { CommandRun, PushRun } from "@intentic/sandbox-contract";
import { outcomeSummary, refusalSummary } from "./fixProposal";

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
