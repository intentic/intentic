import { errorMessage } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { STACKS_MANIFEST_PATH, type StackSpec, type StacksManifest, StacksManifestSchema } from "@intentic/sandbox-contract/schemas/deploys";
import type { z } from "zod";
import { discoverRepos, hasGitEntry, repoDirOf, ROOT_REPO } from "../workspace/layout/repo-discovery.js";

// THE STACKS EACH WORKSPACE REPOSITORY DECLARES (schemas/deploys.ts STACKS_MANIFEST_PATH), read off a COMMIT, never the
// working tree: the board lists what HEAD declares, and a deploy reads the manifest of the very commit it deploys, so
// what runs is what was reviewed and landed with it. A file that does not parse is said per repository and never
// thrown, so one broken manifest hides nothing else.

export type ManifestRead =
    | { readonly kind: "absent" }
    | { readonly kind: "read"; readonly manifest: StacksManifest }
    | { readonly kind: "broken"; readonly error: string };

export interface DeclaredStack {
    readonly repo: string;
    readonly spec: StackSpec;
}

export interface WorkspaceManifests {
    readonly stacks: readonly DeclaredStack[];
    readonly errors: readonly { readonly repo: string; readonly error: string }[];
}

// What zod found wrong, one clause per issue, each at its path in the file.
const issuesOf = (error: z.ZodError): string =>
    error.issues.map((issue) => `${issue.path.length === 0 ? "the file" : issue.path.join(".")}: ${issue.message}`).join("; ");

// The manifest as `rev` holds it. A repository with no commits, or a commit without the file, declares nothing.
export const manifestAt = async (dir: string, rev: string, git: GitRunner = defaultGit): Promise<ManifestRead> => {
    const spot = `${rev}:${STACKS_MANIFEST_PATH}`;
    const kind = await git(dir, ["cat-file", "-t", spot]).then(
        ({ stdout }) => stdout.trim(),
        // allow(silent-catch): git's only answer for a path a commit lacks (or a HEAD that is not there yet) is a failure: it declares nothing
        () => undefined,
    );
    if (kind !== "blob") {
        return { kind: "absent" };
    }
    const { stdout } = await git(dir, ["cat-file", "blob", spot]);
    let raw: unknown;
    try {
        raw = JSON.parse(stdout);
    } catch (error) {
        return { kind: "broken", error: `${STACKS_MANIFEST_PATH} is not JSON: ${errorMessage(error)}` };
    }
    const parsed = StacksManifestSchema.safeParse(raw);
    return parsed.success ? { kind: "read", manifest: parsed.data } : { kind: "broken", error: `${STACKS_MANIFEST_PATH}: ${issuesOf(parsed.error)}` };
};

// Every repository in the workspace, the root's own first when it is one: the same set CI maps (ci/projects.ts).
const workspaceRepos = async (root: string): Promise<string[]> => [
    ...((await hasGitEntry(root)) ? [ROOT_REPO] : []),
    ...(await discoverRepos(root)),
];

// What every repository's HEAD declares, and which manifests could not be read.
export const workspaceManifests = async (root: string, git: GitRunner = defaultGit): Promise<WorkspaceManifests> => {
    const repos = await workspaceRepos(root);
    const read = await Promise.all(
        repos.map(async (repo) => ({
            repo,
            // A repository git cannot read at all is reported like a broken manifest, never thrown over the rest.
            read: await manifestAt(repoDirOf(root, repo), "HEAD", git).catch((error: Error): ManifestRead => ({ kind: "broken", error: error.message })),
        })),
    );
    return {
        stacks: read.flatMap(({ repo, read: found }) => (found.kind === "read" ? found.manifest.stacks.map((spec) => ({ repo, spec })) : [])),
        errors: read.flatMap(({ repo, read: found }) => (found.kind === "broken" ? [{ repo, error: found.error }] : [])),
    };
};
