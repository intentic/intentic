import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Services } from "../../composition.js";
import { conversationTrailer, type CommitSigner, withTrailers } from "../../git-identity.js";
import { attributionFor } from "./commit-attribution.js";

// A commit the Changes panel makes: signed for the person who pressed it, as the owner's policy names people, and
// trailed with every conversation whose landed work the index carries. Until 2026-11-04 a panel commit named nobody,
// and landed work committed from the panel lost the Conversation-Id its land would have written: 0 of the last 300
// commits on intentic's main carried one.

// What the index holds against HEAD, as paths; a rename reads as its two sides, so either one finds its origin.
const stagedPaths = async (dir: string, git: GitRunner): Promise<string[]> => {
    const { stdout } = await git(dir, ["diff", "--cached", "--name-only", "-z", "--no-renames"]);
    return stdout.split("\0").filter((path) => path !== "");
};

// The conversations whose landed work is among `paths`, newest land first, each once.
const landedBy = (origins: Readonly<Record<string, readonly string[]>>, paths: readonly string[]): string[] => [
    ...new Set(paths.flatMap((path) => origins[path] ?? [])),
];

export interface PanelCommit {
    readonly message: string;
    readonly signer: CommitSigner;
}

export const panelCommit = async (
    services: Pick<Services, "config" | "sandboxSettings" | "agentOrigins">,
    commit: { readonly repo: string; readonly dir: string; readonly message: string; readonly member: string | undefined },
    git: GitRunner = defaultGit,
): Promise<PanelCommit> => {
    const [attribution, staged, origins] = await Promise.all([
        attributionFor(services, commit.member),
        // allow(silent-catch): provenance a failed read cannot give is left off; the person's commit still goes in.
        stagedPaths(commit.dir, git).catch((): string[] => []),
        // allow(silent-catch): as above.
        services.agentOrigins.forRepo(commit.repo, commit.dir).catch((): Readonly<Record<string, readonly string[]>> => ({})),
    ]);
    const conversations = landedBy(origins, staged).map(conversationTrailer);
    return { message: withTrailers(commit.message, [...conversations, ...attribution.trailers]), signer: attribution.signer };
};

// The panel's commit itself: whatever is staged, under its signer and trailers; false when the index held nothing.
export const commitAsPanel = async (
    services: Pick<Services, "config" | "sandboxSettings" | "agentOrigins" | "git">,
    commit: Parameters<typeof panelCommit>[1],
    git?: GitRunner,
): Promise<boolean> => {
    const { message, signer } = await panelCommit(services, commit, git);
    return services.git.commitIndex(commit.dir, message, signer, git);
};
