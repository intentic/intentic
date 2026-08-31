import type { ClaimChallenge } from "@intentic-app/api-contract";
import type { GitPublishFileResult } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { claimCommand, claimTargets, domainClaimUrl, isDomainChallenge, publishFailureNotice } from "./publisherClaim.js";

/* WHAT THE CLAIM STEP PROMISES A CREATOR. Two of these are the difference between the screen that shipped and
 * the one that reads as homework: the repository open in front of them is the one offered, and a publish that
 * half-worked says which half. */

const challenge = (repos: readonly string[]): ClaimChallenge => ({
    publisher: `acme`,
    repos: [...repos],
    path: `.intentic-claim`,
    token: `intentic-claim-abc123`,
    claimedByYou: false,
    claimedByOther: false,
});

const published = (over: Partial<GitPublishFileResult>): GitPublishFileResult => ({
    ok: false,
    wrote: false,
    committed: false,
    pushed: false,
    ...over,
});

describe(`claim targets`, () => {
    it(`floats the repositories open in this workspace to the front`, () => {
        const targets = claimTargets(challenge([`acme/one`, `acme/two`, `acme/three`]), [{ repo: `two`, host: `github.com`, project: `acme/two` }]);

        // `acme/two` first because it is the one the creator can prove with a single click.
        expect(targets).toEqual([{ project: `acme/two`, repo: `two` }, { project: `acme/one` }, { project: `acme/three` }]);
    });

    it(`matches a remote whose case differs from the listing, and ignores hosts the proof can't be read from`, () => {
        const targets = claimTargets(challenge([`acme/one`, `acme/two`]), [
            { repo: `one`, host: `github.com`, project: `Acme/One` },
            // Listed under the publisher, checked out here, but the proof is read back off github, so this is
            // not somewhere the file can be published, however well the slug matches.
            { repo: `two`, host: `gitlab.com`, project: `acme/two` },
        ]);

        expect(targets).toEqual([{ project: `acme/one`, repo: `one` }, { project: `acme/two` }]);
    });

    it(`offers every listed repository when none of them is open here`, () => {
        expect(claimTargets(challenge([`acme/one`]), [])).toEqual([{ project: `acme/one` }]);
    });
});

describe(`a publish that did not land`, () => {
    it(`says which half worked, so nobody hunts for a file that is already there`, () => {
        const pushFailed = publishFailureNotice(`acme/one`, published({ wrote: true, committed: true, reason: `no credentials` }));
        const commitFailed = publishFailureNotice(`acme/one`, published({ wrote: true, reason: `git refused` }));
        expect(pushFailed.title).not.toBe(commitFailed.title);
        expect(pushFailed.detail).toContain(`no credentials`);

        const untouched = publishFailureNotice(`acme/one`, published({ reason: `you're on fix/x and this has to land on main` }));
        expect(untouched.detail).toContain(`main`);
        expect(untouched.title).not.toBe(pushFailed.title);
    });
});

describe(`the manual line`, () => {
    it(`carries every step, in the repository it names`, () => {
        const line = claimCommand(challenge([`acme/one`]), `acme/one`);

        expect(line).toContain(`acme/one`);
        expect(line).toContain(challenge([`acme/one`]).token);
        expect(line).toContain(`.intentic-claim`);
        // The three things the old screen made the creator reassemble from prose.
        expect(line).toContain(`git add`);
        expect(line).toContain(`git commit`);
        expect(line).toContain(`git push`);
    });
});

describe(`the domain lane`, () => {
    it(`is told apart by the dot, and spells its URL out whole`, () => {
        const domain: ClaimChallenge = { ...challenge([]), publisher: `acme.dev`, path: `.well-known/intentic-claim` };
        expect(isDomainChallenge(domain)).toBe(true);
        expect(isDomainChallenge(challenge([`acme/one`]))).toBe(false);
        expect(domainClaimUrl(domain)).toBe(`https://acme.dev/.well-known/intentic-claim`);
    });
});
