import type { CommandRun } from "@intentic/sandbox-contract/schemas/ci";
import type { PushRun } from "@intentic/sandbox-contract/schemas/git/git";
import { credentialHostOf, outcomeSummary, pushNeedsPull, refusalSummary } from "./refusalSummary";

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

// A push refused for want of a sign-in names the host whose account fixes it; every other refusal names none.
test(`a push the remote refused for its credential names the host to connect, and no other refusal does`, () => {
    const refused: PushRun = {
        ...push,
        refusedBy: `transport`,
        reason: `fatal: Authentication failed for 'https://github.com/x/tabularium.git/'`,
        output: `remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/x/tabularium.git/'`,
    };
    expect(credentialHostOf(refused)).toBe(`github`);
    expect(
        credentialHostOf({ ...refused, reason: `fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled`, output: `` }),
    ).toBe(`gitlab`);
    expect(credentialHostOf(push)).toBeUndefined();
    expect(credentialHostOf({ ...refused, reason: `fatal: Could not read from remote repository.`, output: `` })).toBeUndefined();
    expect(credentialHostOf({ ...refused, reason: `fatal: Authentication failed for 'https://git.example.com/x.git/'`, output: `` })).toBeUndefined();
});

test(`access refusals lead to the account that needs write permission`, () => {
    const refused = { ...push, refusedBy: `transport` as const, reason: undefined };
    expect(credentialHostOf({ ...refused, output: `remote: Permission to acme/app.git denied to reader.\nfatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403` })).toBe(`github`);
    expect(credentialHostOf({ ...refused, output: `git@github.com: Permission denied (publickey).` })).toBe(`github`);
    expect(credentialHostOf({ ...refused, output: `remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/acme/app.git/'` })).toBe(`gitlab`);
    expect(credentialHostOf({ ...refused, output: `remote: Repository not found.\nfatal: repository 'https://github.com/acme/gone.git/' not found` })).toBeUndefined();
});

test(`only rejected refs needing remote commits offer a pull before retry`, () => {
    const rejected = { ...push, refusedBy: `remote` as const, output: `` };
    expect(pushNeedsPull({ ...rejected, reason: `! [rejected] main -> main (fetch first)` })).toBe(true);
    expect(pushNeedsPull({ ...rejected, reason: `! [rejected] main -> main (non-fast-forward)` })).toBe(true);
    expect(pushNeedsPull({ ...rejected, refusedBy: undefined, output: `! [rejected] main -> main (fetch first)` })).toBe(true);
    expect(pushNeedsPull({ ...rejected, reason: `! [remote rejected] main -> main (protected branch hook declined)` })).toBe(false);
    expect(pushNeedsPull({ ...rejected, refusedBy: `hook`, output: `! [rejected] main -> main (fetch first)` })).toBe(false);
    expect(pushNeedsPull({ ...rejected, timedOut: true, output: `! [rejected] main -> main (fetch first)` })).toBe(false);
});
