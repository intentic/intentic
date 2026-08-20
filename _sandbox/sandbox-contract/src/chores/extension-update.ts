import { composeAsk } from "./prompt.js";

/* AN EXTENSION UPDATE, READ AS A DIFF. The commit that is installed was approved once already, re-reading all
 * of it would bury the one question an update asks: what is different, and did any of it change the deal? So
 * the turn's subject is the diff between the two commits, and the manifest's delta leads, because a new entry
 * in `permissions.sandbox` is reach the owner never approved, arriving dressed as an update.
 *
 * Here in the contract's chores rather than in the web app, because two callers build it: the update card's
 * "read the diff" button, and the daemon's agent-prepared update policy, which runs this exact read
 * unprompted when the registry lists a new sha, so the owner opens a finished account instead of starting one. */
const UPDATE_INVARIANTS =
    `This turn reads and reports; it changes nothing and installs nothing. Clone into a scratch directory ` +
    `outside the workspace and read the diff between the two commits — the installed code was approved once ` +
    `already, so what is between them is the whole subject. Lead with the manifest's delta: any route added to ` +
    `\`permissions.sandbox\` is reach the owner never approved and the headline whatever else changed. Then the ` +
    `code: what behaviour changed, in the owner's terms, citing file and line.`;

export interface UpdateBrief {
    // The listing's display name, or the repository when it is being installed straight from a URL.
    readonly label: string;
    readonly url: string;
    // What is installed and what the update proposes, both full shas, both facts, neither a branch.
    readonly fromRef: string;
    readonly toRef: string;
    // Subdirectory inside the repository, for a monorepo source. Empty for a repo of its own.
    readonly path: string;
}

export const updateBrief = ({ label, url, fromRef, toRef, path }: UpdateBrief): string =>
    composeAsk({
        subject: `Read what changed in the ${label} extension before it is updated here: ${url}, from ${fromRef} to ${toRef}${path === `` ? `` : `, in ${path}`}.`,
        why: `The installed commit was approved once already; the update replaces it wholesale, because the sha is the identity and there is no build step between the pushed bytes and the code that runs.`,
        diagnosis: `The manifest (intentic-extension.json at the extension root) is the contract on both sides of the diff, so its delta is readable exactly like the code's.`,
        goal: `Read the diff and say what the update actually is: the manifest delta first, then what the code now does that it did not, and what it stopped doing.`,
        invariants: UPDATE_INVARIANTS,
        done: `Done when you end on a recommendation the owner can act on — update, update and watch something named, or stay on ${fromRef.slice(0, 7)} — with the change that decided it cited by file and line.`,
    });
