import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extensionIdOf } from "@intentic/extension-manifest";
import {
    AutomationSchema,
    type DefinitionAction,
    type DefinitionWorkspace,
    type WorkspacePublish,
    type WorkspacePublishResult,
    type WorkspaceRemote,
} from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { isPublicPath } from "@intentic/workspace-ignore";
import { z } from "zod";
import { type GitHost, gitHostOf, githubHeaders } from "../capabilities/cli/git-access.js";
import { parseExtensionManifest, workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";
import { defaultBranchOf } from "../git/publish-file.js";
import { pushBranch, remoteState } from "../git/remote.js";
import { ROOT_BASELINE_CONFIG, ROOT_FRESH_CONFIG } from "../git/root-repo.js";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import { rootPathIsExcluded } from "../history/history.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import { DEFINITION_SOURCES } from "./definition.js";

/* THE WORKSPACE AS A REFERENCE: publishing /work, and taking somebody's published /work into a fresh sandbox.
 *
 * /work has always been a git repo — the daemon's `root` scope, git dir on /history, in-worktree `.git` a
 * pointer file (git/root-repo.ts). Its exclude list is DERIVED from the contract's `versioned` flag, so it
 * tracks every workspace file that is not a nested repo, the reference shelf, or daemon-internal state, which
 * by that allowlist means the owner's authored content: notes, skills, personas, automations, workflow and
 * loop designs, drafts, workspace extensions. Until it had a remote, none of that could travel by reference
 * and a bundle was the only door. This module is the two halves of giving it one.
 *
 * THE ARRIVAL IS THE HARD HALF, and the reason is the format's own promise: a definition is safe to publish,
 * which means it is also a file a stranger may hand you. The typed sections keep that promise by construction,
 * a capability lands unauthenticated, an overlay lands as a proposal. A CHECKOUT keeps nothing by
 * construction: whatever is in the tree is what lands. The fetched tree is therefore inspected and rewritten
 * in a detached temporary worktree BEFORE it can touch /work: private/ignored paths and executable git entry
 * types are refused, typed definition sources keep the target's bytes, and everything that acts on its own is
 * switched off. Only that inert tree is checked out. There is no live unsafe window for a watcher to catch.
 */

export class WorkspaceRemoteError extends Error {}

/* Git's own words, WHOLE, where the ordinary one-line verdict would throw the answer away. A checkout refusal
 * reads
 *
 *   error: The following untracked working tree files would be overwritten by checkout:
 *   	notes.md
 *   Please move or remove them before you switch branches.
 *   Aborting
 *
 * and the middle of that is the entire point: WHICH files. gitFailureReason keeps the last verdict line, which
 * is right for "the push was rejected" and useless for this one. */
const gitRefusal = (error: unknown, fallback: string): string => {
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : error instanceof Error ? error.message : String(error);
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    return lines.length === 0 ? fallback : lines.join(" ");
};

// The connected github/gitlab accounts, in the order a publish would try them. Same resolution the CI project
// mapping and git access ride (ci/projects.ts), so "which hosts can I publish to" and "which hosts do my repos
// belong to" can never answer differently.
const gitHosts = async (services: Services): Promise<GitHost[]> =>
    (await services.capabilities.list()).flatMap((capability) => {
        if (capability.kind !== "cli" || (capability.config.provider !== "github" && capability.config.provider !== "gitlab")) {
            return [];
        }
        try {
            return [gitHostOf(capability.config)];
        } catch {
            // A gitlab capability with an unparseable instance url publishes nowhere; it fails its own probe.
            return [];
        }
    });

// The URL of a repo's configured remote, or undefined when it has none this daemon can read. Total: every
// failure here is an ordinary state (no remote yet, a remote with no URL), never an exception to render.
const remoteUrlOf = async (dir: string, git: GitRunner): Promise<{ remote?: string; branch?: string }> => {
    const state = await remoteState(dir, {}, git).catch(() => ({ ahead: 0, behind: 0 }) as Awaited<ReturnType<typeof remoteState>>);
    const branch = state.branch === undefined || state.branch === "" ? undefined : state.branch;
    if (state.remote === undefined) {
        return { ...(branch === undefined ? {} : { branch }) };
    }
    const url = (await git(dir, ["remote", "get-url", state.remote]).catch(() => undefined))?.stdout.trim();
    return { ...(url === undefined || url === "" ? {} : { remote: url }), ...(branch === undefined ? {} : { branch }) };
};

// Whether /work is already published, the one fact the apply's applicability turns on.
export const workspaceRemoteUrl = async (root: string, git: GitRunner = defaultGit): Promise<string | undefined> =>
    (await remoteUrlOf(root, git)).remote;

// Where /work stands and where it could go, the card's first render: published or not, and which hosts could
// publish it. Read-only.
export const workspaceRemote = async (services: Services, git: GitRunner = defaultGit): Promise<WorkspaceRemote> => ({
    ...(await remoteUrlOf(services.workspace.root, git)),
    hosts: (await gitHosts(services)).map((host) => host.host),
});

/* WHETHER A DEFINITION MAY MATERIALIZE A WORKSPACE HERE, the `beside, never over` rule as it has to be spelled
 * for a checkout that owns the whole tree. Commit count and message are not provenance: somebody else's
 * one-commit repository can look exactly like the daemon's baseline. The daemon records the exact baseline
 * sha in protected git config, and a fresh marker covers only the unborn boot-seed window before that commit.
 * A changed HEAD or any visible worktree change makes the workspace somebody's work and therefore ineligible. */
export const workspaceIsPristine = async (root: string, git: GitRunner = defaultGit): Promise<boolean> => {
    const head = await git(root, ["rev-parse", "-q", "--verify", "HEAD"])
        .then(({ stdout }) => stdout.trim())
        .catch(() => "");
    if (head === "") {
        return (await git(root, ["config", "--get", ROOT_FRESH_CONFIG]).catch(() => undefined))?.stdout.trim() === "true";
    }
    const baseline = (await git(root, ["config", "--get", ROOT_BASELINE_CONFIG]).catch(() => undefined))?.stdout.trim();
    if (baseline !== head) {
        return false;
    }
    const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).catch(() => undefined);
    return status !== undefined && status.stdout === "";
};

interface WorkspaceTreeEntry {
    readonly mode: string;
    readonly type: string;
    readonly path: string;
}

const treeEntries = async (root: string, commit: string, git: GitRunner): Promise<WorkspaceTreeEntry[]> =>
    (await git(root, ["ls-tree", "-r", "-z", "--full-tree", commit])).stdout
        .split("\0")
        .filter((entry) => entry !== "")
        .map((entry) => {
            const tab = entry.indexOf("\t");
            const [mode, type] = entry.slice(0, tab).split(" ");
            if (tab === -1 || mode === undefined || type === undefined) {
                throw new WorkspaceRemoteError("the workspace remote returned a tree entry git could not describe safely");
            }
            return { mode, type, path: entry.slice(tab + 1) };
        });

// Every path the root repository itself excludes is refused, rather than trusted merely because a foreign
// repository force-added it. Symlinks and gitlinks are refused too: the former can redirect a later write out
// of the inspected tree, and the latter is a nested repository with a second, uninspected source. `public/` is
// an additional arrival-only refusal because creating it is the switch that serves its contents to the world.
const preflightTree = async (root: string, commit: string, git: GitRunner): Promise<void> => {
    const repoIds = await discoverRepos(root);
    for (const entry of await treeEntries(root, commit, git)) {
        if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
            throw new WorkspaceRemoteError(`the workspace remote contains ${entry.path} as an unsupported ${entry.type} (${entry.mode})`);
        }
        if (rootPathIsExcluded(entry.path, repoIds)) {
            throw new WorkspaceRemoteError(
                `the workspace remote tracks ${entry.path}, which is private, ignored, or belongs to another repository in /work`,
            );
        }
        if (isPublicPath(entry.path)) {
            throw new WorkspaceRemoteError(
                `the workspace remote tracks ${entry.path}; a top-level public/ directory publishes files immediately and must be created deliberately`,
            );
        }
    }
};

const optionalFile = async (path: string): Promise<Buffer | undefined> => {
    try {
        return await readFile(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
};

const replaceFile = async (root: string, path: string, content: Buffer | string | undefined): Promise<void> => {
    const target = join(root, path);
    if (content === undefined) {
        await rm(target, { recursive: true, force: true });
        return;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
};

const APPROVED_OVERLAY = ".intentic/config/environment.custom.Dockerfile";
const WORKSPACE_OVERLAY_DRAFT = ".intentic/config/environment.d/workspace.Dockerfile";
const AUTOMATIONS = ".intentic/config/automations.json";
const EXTENSION_ENABLEMENT = ".intentic/config/extension-enablement.json";
const EnablementSchema = z.record(z.string(), z.boolean());

const parsedJsonFile = async <T>(path: string, schema: z.ZodType<T>, label: string): Promise<T | undefined> => {
    const bytes = await optionalFile(path);
    if (bytes === undefined) {
        return undefined;
    }
    try {
        return schema.parse(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
        throw new WorkspaceRemoteError(`${label} cannot arrive safely: ${error instanceof Error ? error.message : String(error)}`);
    }
};

const stillAutomations = async (root: string): Promise<DefinitionAction | undefined> => {
    const path = join(root, AUTOMATIONS);
    const automations = await parsedJsonFile(path, z.array(AutomationSchema), AUTOMATIONS);
    if (automations === undefined) {
        return undefined;
    }
    const enabled = automations.filter((automation) => automation.enabled);
    if (enabled.length === 0) {
        return undefined;
    }
    await replaceFile(
        root,
        AUTOMATIONS,
        `${JSON.stringify(
            automations.map((automation) => ({ ...automation, enabled: false })),
            null,
            2,
        )}\n`,
    );
    return {
        subject: "Turn on the automations you want",
        detail: `${enabled.length} automation${enabled.length === 1 ? "" : "s"} arrived with the workspace and ${enabled.length === 1 ? "is" : "are"} switched OFF, because the scheduler fires enabled ones unattended: ${enabled.map((automation) => automation.id).join(", ")}. Enable the ones you want on the Automations view.`,
    };
};

const stillExtensions = async (
    root: string,
    targetEnablement: Readonly<Record<string, boolean>>,
    targetHadEnablement: boolean,
): Promise<DefinitionAction | undefined> => {
    const extensionsRoot = workspaceExtensionsRoot(root);
    const entries = await readdir(extensionsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    });
    const ids: string[] = [];
    for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith(".")).toSorted((a, b) => a.name.localeCompare(b.name))) {
        const parsed = await parseExtensionManifest(join(extensionsRoot, entry.name));
        if ("error" in parsed) {
            throw new WorkspaceRemoteError(`workspace extension ${entry.name} cannot be disabled safely: ${parsed.error}`);
        }
        ids.push(extensionIdOf(parsed.manifest));
    }
    await replaceFile(
        root,
        EXTENSION_ENABLEMENT,
        ids.length === 0 && !targetHadEnablement
            ? undefined
            : `${JSON.stringify({ ...targetEnablement, ...Object.fromEntries(ids.map((id) => [id, false])) }, null, 2)}\n`,
    );
    if (ids.length === 0) {
        return undefined;
    }
    return {
        subject: "Enable the workspace extensions you trust",
        detail: `${ids.length} workspace extension${ids.length === 1 ? "" : "s"} arrived with the workspace and ${ids.length === 1 ? "is" : "are"} switched OFF, because an extension's code runs in this sandbox once it is on: ${ids.join(", ")}. Turn on the ones you trust on the Extensions view.`,
    };
};

const gateOverlay = async (root: string, incoming: Buffer | undefined, handledBySection: boolean): Promise<DefinitionAction | undefined> => {
    const custom = incoming?.toString("utf8").trim() ?? "";
    if (custom === "" || handledBySection) {
        return undefined;
    }
    const proposed = `${custom}\n`;
    const existing = await optionalFile(join(root, WORKSPACE_OVERLAY_DRAFT));
    if (existing !== undefined && !existing.equals(Buffer.from(proposed))) {
        throw new WorkspaceRemoteError(
            `${APPROVED_OVERLAY} cannot be gated safely because the workspace already contains a different ${WORKSPACE_OVERLAY_DRAFT}`,
        );
    }
    await replaceFile(root, WORKSPACE_OVERLAY_DRAFT, proposed);
    return {
        subject: "Approve and rebuild the environment",
        detail: "The workspace carried an overlay. It landed as a proposal on the Environment card, never as a build: review it, approve it, then run the rebuild command the card shows.",
    };
};

const safeWorkspaceCommit = async (
    services: Services,
    commit: string,
    options: { readonly overlayHandledBySection: boolean },
    git: GitRunner,
): Promise<{ readonly commit: string; readonly actions: DefinitionAction[] }> => {
    const root = services.workspace.root;
    const targetSources = new Map<string, Buffer | undefined>();
    for (const path of DEFINITION_SOURCES) {
        targetSources.set(path, await optionalFile(join(root, path)));
    }
    const targetEnablementBytes = await optionalFile(join(root, EXTENSION_ENABLEMENT));
    const targetEnablement = (await parsedJsonFile(join(root, EXTENSION_ENABLEMENT), EnablementSchema, `the target's ${EXTENSION_ENABLEMENT}`)) ?? {};

    const stage = await mkdtemp(join(tmpdir(), "intentic-workspace-arrival-"));
    await rm(stage, { recursive: true, force: true });
    let registered = false;
    try {
        await git(root, ["worktree", "add", "--detach", stage, commit]);
        registered = true;
        const incomingOverlay = await optionalFile(join(stage, APPROVED_OVERLAY));
        for (const [path, content] of targetSources) {
            await replaceFile(stage, path, content);
        }
        // The remote's switch file never gets authority over extensions already installed in the target. Start
        // from the target's choices and add an explicit false for every piece of workspace extension code.
        await replaceFile(stage, EXTENSION_ENABLEMENT, undefined);
        const actions = [
            await gateOverlay(stage, incomingOverlay, options.overlayHandledBySection),
            await stillAutomations(stage),
            await stillExtensions(stage, targetEnablement, targetEnablementBytes !== undefined),
        ].filter((action): action is DefinitionAction => action !== undefined);
        await git(stage, ["add", "-A"]);
        await git(stage, [
            "-c",
            `user.name=${AGENT_GIT_AUTHOR.name}`,
            "-c",
            `user.email=${AGENT_GIT_AUTHOR.email}`,
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "Prepare safe workspace arrival",
        ]);
        return { commit: (await git(stage, ["rev-parse", "HEAD"])).stdout.trim(), actions };
    } finally {
        if (registered) {
            await git(root, ["worktree", "remove", "--force", stage]).catch(() => undefined);
        }
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
        await git(root, ["worktree", "prune"]).catch(() => undefined);
    }
};

/* Take a published workspace into this one without ever checking the foreign tree out live. Fetching only
 * writes the protected git dir. The tree is preflighted and made inert in a temporary worktree; the target sees
 * a single checkout of that safe commit, with ignored-file overwrites explicitly forbidden. The branch is then
 * moved back to the remote commit with a mixed reset, so the safety rewrites remain visible local changes and
 * can never be pushed upstream as though the source owner authored them. */
export const adoptWorkspaceRemote = async (
    services: Services,
    workspace: DefinitionWorkspace,
    options: { readonly overlayHandledBySection: boolean },
    git: GitRunner = defaultGit,
): Promise<{ readonly branch: string; readonly actions: DefinitionAction[] }> => {
    const root = services.workspace.root;
    let checkedOut = false;
    await git(root, ["remote", "add", "origin", workspace.remote]).catch((error: unknown) => {
        throw new WorkspaceRemoteError(gitRefusal(error, "could not add the workspace remote"));
    });
    try {
        await git(root, ["fetch", "--no-tags", "origin"]);
        const ref = (workspace.ref ?? "").trim();
        const branch = ref === "" ? await defaultBranchOf(root, "origin", git) : ref;
        if (branch === undefined || branch === "") {
            throw new WorkspaceRemoteError(`${workspace.remote} advertises no default branch; name one with \`ref\` in the definition`);
        }
        await git(root, ["check-ref-format", "--branch", branch]).catch(() => {
            throw new WorkspaceRemoteError(`${JSON.stringify(branch)} is not a safe branch name`);
        });
        const remoteCommit = (await git(root, ["rev-parse", "--verify", `origin/${branch}^{commit}`])).stdout.trim();
        await preflightTree(root, remoteCommit, git);
        const prepared = await safeWorkspaceCommit(services, remoteCommit, options, git);
        await git(root, ["checkout", "--no-overwrite-ignore", "-B", branch, prepared.commit]);
        checkedOut = true;
        // Move HEAD + index to the real remote commit without touching the already-safe worktree. The disabled
        // switches and target-owned source files now read as deliberate local differences from upstream.
        await git(root, ["reset", "--mixed", remoteCommit]);
        await git(root, ["config", "--unset-all", ROOT_FRESH_CONFIG]).catch(() => undefined);
        await git(root, ["config", "--unset-all", ROOT_BASELINE_CONFIG]).catch(() => undefined);
        // Upstream is a convenience, not part of landing the tree: a remote whose ref layout surprises us
        // still leaves a correct checkout behind.
        await git(root, ["branch", `--set-upstream-to=origin/${branch}`, branch]).catch(() => undefined);
        return { branch, actions: prepared.actions };
    } catch (error) {
        if (!checkedOut) {
            await git(root, ["remote", "remove", "origin"]).catch(() => undefined);
        }
        throw error instanceof WorkspaceRemoteError ? error : new WorkspaceRemoteError(gitRefusal(error, "could not check out the workspace"));
    }
};

/* ---- publishing ----
 *
 * The other half, and the one a definition cannot do for itself: `[workspace]` names a remote, and nothing can
 * name one that does not exist. Deliberately its own owner-gated route rather than a side effect of the
 * export, publishing a workspace is an OUTWARD act with its own confirmation, and deriving a document has to
 * stay read-only.
 *
 * What travels is decided by root's exclude list, not by this function: nested repos, the reference shelf,
 * `.intentic/local` and `.intentic/secrets`, `.env*` and the junk dirs are all outside the repo already, which
 * is what makes pushing a workspace safe to offer at all.
 */

const created = async (host: GitHost, name: string, owner: string | undefined): Promise<string> => {
    if (host.provider === "gitlab") {
        const response = await fetch(`${host.apiBase}/projects`, {
            method: "POST",
            headers: { "PRIVATE-TOKEN": host.token, "Content-Type": "application/json" },
            body: JSON.stringify({ name, path: name, visibility: "private" }),
        });
        if (!response.ok) {
            throw new WorkspaceRemoteError(
                `${host.host} refused to create "${name}": ${response.status} ${await response.text().catch(() => "")}`.trim(),
            );
        }
        const body = (await response.json().catch(() => ({}))) as { http_url_to_repo?: string };
        if (typeof body.http_url_to_repo !== "string" || body.http_url_to_repo === "") {
            throw new WorkspaceRemoteError(`${host.host} created the project but returned no clone URL`);
        }
        return body.http_url_to_repo;
    }
    // github: an owner that is not the authenticated user is an organization, which has its own endpoint.
    const login = await fetch(`${host.apiBase}/user`, { headers: githubHeaders(host.token) })
        .then(async (response) => ((await response.json().catch(() => ({}))) as { login?: string }).login)
        .catch(() => undefined);
    const path = owner === undefined || owner === login ? "/user/repos" : `/orgs/${encodeURIComponent(owner)}/repos`;
    const response = await fetch(`${host.apiBase}${path}`, {
        method: "POST",
        headers: { ...githubHeaders(host.token), "Content-Type": "application/json" },
        body: JSON.stringify({ name, private: true, auto_init: false }),
    });
    if (!response.ok) {
        throw new WorkspaceRemoteError(
            `${host.host} refused to create "${name}": ${response.status} ${await response.text().catch(() => "")}`.trim(),
        );
    }
    const body = (await response.json().catch(() => ({}))) as { clone_url?: string };
    if (typeof body.clone_url !== "string" || body.clone_url === "") {
        throw new WorkspaceRemoteError(`${host.host} created the repository but returned no clone URL`);
    }
    return body.clone_url;
};

// A repo name from the sandbox's own name, since that is what the owner will recognise in a list of repos.
// Nothing derives authority from it; an empty or unusable name falls back to a fixed one.
const repoNameFrom = (name: string): string => {
    const cleaned = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return cleaned === "" ? "intentic-workspace" : cleaned;
};

export const publishWorkspace = async (services: Services, input: WorkspacePublish, git: GitRunner = defaultGit): Promise<WorkspacePublishResult> => {
    const root = services.workspace.root;
    const { remote: existing } = await remoteUrlOf(root, git);
    if (existing !== undefined) {
        throw new WorkspaceRemoteError(`this workspace is already published at ${existing}`);
    }
    const supplied = (input.remote ?? "").trim();
    let remote = supplied;
    if (remote === "") {
        const host = (await gitHosts(services))[0];
        if (host === undefined) {
            throw new WorkspaceRemoteError(
                "no github or gitlab account is connected, so there is nowhere to create the repository; connect one, or paste a URL you made yourself",
            );
        }
        remote = await created(host, repoNameFrom(input.name ?? services.config.sandbox.name), input.owner);
    }
    await git(root, ["remote", "add", "origin", remote]).catch((error: unknown) => {
        throw new WorkspaceRemoteError(gitRefusal(error, "could not add the workspace remote"));
    });
    const branch = (await git(root, ["branch", "--show-current"]).catch(() => undefined))?.stdout.trim() ?? "";
    if (branch === "") {
        await git(root, ["remote", "remove", "origin"]).catch(() => undefined);
        throw new WorkspaceRemoteError("the workspace has no branch checked out to push");
    }
    const pushed = await pushBranch(root, { branch }, git);
    if (!pushed.ok) {
        // The remote comes back off on a failed push for the reason the adopt path un-wires its own: a remote
        // nothing was pushed to would still make `deriveDefinition` claim a `[workspace]` nobody can clone.
        await git(root, ["remote", "remove", "origin"]).catch(() => undefined);
        throw new WorkspaceRemoteError(pushed.reason);
    }
    return { remote, branch, created: supplied === "" };
};
