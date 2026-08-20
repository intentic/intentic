import type { ClaimChallenge } from "@intentic-app/api-contract";
import type { GitPublishFileResult, GitRemoteRepo } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import type { NoticeModel } from "@intentic/ui";

/* THE CLAIM STEP'S DECISIONS, kept out of the component so they can be argued with in a test.
 *
 * All three of these exist because of the same UX finding: the screen used to hand the creator a token and a
 * comma-separated list of six repository slugs and leave them to it. Nothing on it said the list was fixed by
 * the registry rather than a free choice, that any ONE of them was enough, or which one to prefer, so it read
 * as homework with six unexplained options, and the most common outcome was a file pushed to a side branch
 * followed by a verify failure that said nothing about branches. */

export interface ClaimTarget {
    // The repository as the registry names it: `owner/name`.
    readonly project: string;
    // The workspace repo id it is checked out as, when it is, the thing that makes one-click possible.
    readonly repo?: string;
}

/* THE DOMAIN LANE, told apart by the dot, the platform's own discriminator (a registry publisher name is
 * the prefix of an extension id before its first dot, so it can never contain one). A dotted challenge has
 * no repositories at all: its proof is a file served from the domain itself. */
export const isDomainChallenge = (challenge: ClaimChallenge): boolean => challenge.publisher.includes(`.`);

// Where the domain lane's proof must be readable, spelled out whole because "the well-known path" is
// exactly the kind of sentence that used to make the repo lane feel like homework.
export const domainClaimUrl = (challenge: ClaimChallenge): string => `https://${challenge.publisher}/${challenge.path}`;

/* Every repository the claim can be proved from, each marked with the workspace repo it is open as. Order is
 * the registry's, EXCEPT that ones open here float to the front: the first entry is what the screen offers by
 * default, and an offer the creator can accept with one click beats one that sends them to a terminal.
 *
 * Matching is case-insensitive because github is: a remote spelled `Acme/Web` and a listing spelled `acme/web`
 * are the same repository, and failing to notice that would silently drop the one-click path. */
export const claimTargets = (challenge: ClaimChallenge, local: readonly GitRemoteRepo[]): readonly ClaimTarget[] => {
    const here = new Map<string, string>();
    for (const entry of local) {
        // Only github: the proof is read back from raw.githubusercontent.com, so a repo hosted elsewhere is not
        // somewhere this file can be published to even if its slug happens to match.
        if (entry.host === `github.com` && !here.has(entry.project.toLowerCase())) {
            here.set(entry.project.toLowerCase(), entry.repo);
        }
    }
    const targets = challenge.repos.map((project) => {
        const repo = here.get(project.toLowerCase());
        return repo === undefined ? { project } : { project, repo };
    });
    return [...targets.filter((target) => target.repo !== undefined), ...targets.filter((target) => target.repo === undefined)];
};

/* WHAT TO SAY WHEN THE ONE-CLICK PUBLISH DID NOT LAND. The daemon reports the three steps separately precisely
 * so this can distinguish them, because each leaves the creator somewhere different: nothing happened, a file
 * is sitting uncommitted in their workspace, or a real commit is sitting there unpushed. Collapsing all three
 * into "couldn't publish" is what would send someone hunting for a file they think was never written. */
export const publishFailureNotice = (project: string, result: GitPublishFileResult): NoticeModel => {
    // The daemon's own words go in `detail`: they name the branch, or quote git. The title is this screen's
    // account of what state the creator has been left in, which the daemon has no way to phrase.
    const detail = result.reason;
    if (result.committed && !result.pushed) {
        return { tone: `danger`, title: `Saved into ${project}, but GitHub wouldn't take the push.`, detail, key: `claim-publish` };
    }
    if (result.wrote && !result.committed) {
        return { tone: `danger`, title: `The proof file is in ${project} but couldn't be recorded.`, detail, key: `claim-publish` };
    }
    return { tone: `danger`, title: `Nothing was changed in ${project}.`, detail, key: `claim-publish` };
};

/* THE MANUAL PATH, AS ONE LINE TO PASTE. The old screen gave out the token alone and left the creator to work
 * out the filename, the commit and the push from a sentence, four steps to reassemble, each of which is a way
 * to get it subtly wrong. One line that does all of it removes every one of those.
 *
 * `cd` is deliberately part of it: the creator is being told to do this in a repository that may not be the one
 * their terminal is in, and a line that silently writes the file into the wrong directory is worse than no line.
 *
 * Every value crosses into a shell the creator is about to run, so every one goes through `shellQuote` rather
 * than a bare `'…'`, the token, the path and the publisher name are all server-supplied, and "a token never
 * contains an apostrophe" is exactly the assumption the quoters exist to stop anyone making again. A plain
 * value quotes to itself, so the line a creator actually sees is byte-identical to the one written by hand. */
export const claimCommand = (challenge: ClaimChallenge, project: string): string => {
    const path = shellQuote(challenge.path);
    return [
        `# in your clone of ${project}, on its default branch`,
        `printf '%s\\n' ${shellQuote(challenge.token)} > ${path}`,
        `git add ${path} && git commit -m ${shellQuote(`Claim the ${challenge.publisher} publisher name`)} && git push`,
    ].join(`\n`);
};
