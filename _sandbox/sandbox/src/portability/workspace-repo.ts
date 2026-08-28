import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { extensionIdOf } from "@intentic/extension-manifest";
import type { DefinitionAction, DefinitionWorkspace, WorkspacePublish, WorkspacePublishResult, WorkspaceRemote } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { type GitHost, gitHostOf, githubHeaders } from "../capabilities/cli/git-access.js";
import { parseExtensionManifest, workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";
import { customPath, draftsDir } from "../environment/environment.js";
import { defaultBranchOf } from "../git/publish-file.js";
import { pushBranch, remoteState } from "../git/remote.js";
import { writeExtensionEnablement } from "../extensions/extension-enablement.js";

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
 * construction: whatever is in the tree is what lands. Three of the things in that tree act on their own, so
 * three of them are neutralized on arrival (neutralizeWorkspaceArrival), and everything else in it is inert
 * until a person opens it. That list is short, and it is the whole security argument for this section.
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
export const workspaceRemoteUrl = async (root: string, git: GitRunner = defaultGit): Promise<string | undefined> => (await remoteUrlOf(root, git)).remote;

// Where /work stands and where it could go, the card's first render: published or not, and which hosts could
// publish it. Read-only.
export const workspaceRemote = async (services: Services, git: GitRunner = defaultGit): Promise<WorkspaceRemote> => ({
    ...(await remoteUrlOf(services.workspace.root, git)),
    hosts: (await gitHosts(services)).map((host) => host.host),
});

/* WHETHER A DEFINITION MAY MATERIALIZE A WORKSPACE HERE, the `beside, never over` rule as it has to be spelled
 * for a checkout that owns the whole tree.
 *
 * A repo item asks "does this directory exist"; /work always exists, so the equivalent question is whether
 * this workspace has a history of its OWN. A fresh sandbox has exactly one commit, the daemon's own
 * `Initialize workspace` baseline (git/root-repo.ts), or none at all at boot-seed time, when the seed runs
 * before the baseline step. Anything beyond that is somebody's work, and taking a foreign tree over it is
 * precisely the force-convergence this surface refuses to do.
 */
export const workspaceIsPristine = async (root: string, git: GitRunner = defaultGit): Promise<boolean> => {
    const head = await git(root, ["rev-parse", "-q", "--verify", "HEAD"])
        .then(({ stdout }) => stdout.trim())
        .catch(() => "");
    if (head === "") {
        return true; // unborn: the boot seed's own moment, before commitRootBaseline runs
    }
    const counted = (await git(root, ["rev-list", "--count", "HEAD"]).catch(() => undefined))?.stdout.trim();
    return counted === "1";
};

/* Take a published workspace into this one: wire the remote, fetch, and check the branch out.
 *
 * `checkout -B` is doing real work here, not just moving a ref: git REFUSES it when an untracked file in the
 * tree would be overwritten, and names the files. That refusal IS the "never over" guarantee, enforced by the
 * tool rather than by a rule this module remembers to apply, and it surfaces as the item's failure row.
 *
 * A failure un-wires the remote it added. Half-applied is the one state that would be genuinely confusing
 * here: `deriveDefinition` reads the remote, so a workspace that failed to materialize would start emitting a
 * `[workspace]` section for a tree it never took.
 */
export const adoptWorkspaceRemote = async (root: string, workspace: DefinitionWorkspace, git: GitRunner = defaultGit): Promise<string> => {
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
        await git(root, ["checkout", "-B", branch, `origin/${branch}`]);
        // Upstream is a convenience, not part of landing the tree: a remote whose ref layout surprises us
        // still leaves a correct checkout behind.
        await git(root, ["branch", `--set-upstream-to=origin/${branch}`, branch]).catch(() => undefined);
        return branch;
    } catch (error) {
        await git(root, ["remote", "remove", "origin"]).catch(() => undefined);
        throw error instanceof WorkspaceRemoteError ? error : new WorkspaceRemoteError(gitRefusal(error, "could not check out the workspace"));
    }
};

/* ---- what a checked-out workspace must not be allowed to do on its own ----
 *
 * Everything else a workspace repo carries waits for a person: a workflow or loop design until someone runs
 * it, a draft until someone approves it, a persona until someone picks it, a skill until an agent reads it.
 * These three act by themselves, so these three arrive switched off. Each is turned off through the daemon's
 * own write path, so the owner turns it back on in the ordinary UI rather than by editing a file.
 */

// The overlay: `composeEnvironment` folds the custom section into the APPROVED file, so a checked-out
// `environment.custom.Dockerfile` would arrive already approved, which is exactly the consent the apply's
// draft-only rule refuses to import. Handed to the same approval gate instead, unless the definition's own
// `[environment]` section is about to park the identical content there.
const gateOverlay = async (services: Services, overlayHandledBySection: boolean): Promise<DefinitionAction | undefined> => {
    const custom = ((await services.files.read(customPath(services))) ?? "").trim();
    if (custom === "") {
        return undefined;
    }
    await services.files.remove(customPath(services));
    if (overlayHandledBySection) {
        return undefined; // the environment item parks it, and says so in its own needsAction line
    }
    await services.files.write(join(draftsDir(services), "workspace.Dockerfile"), `${custom}\n`);
    return {
        subject: "Approve and rebuild the environment",
        detail: "The workspace carried an overlay. It landed as a proposal on the Environment card, never as a build: review it, approve it, then run the rebuild command the card shows.",
    };
};

// Automations: the scheduler fires every ENABLED automation, and nobody consented to a stranger's schedule
// (or to wakes naming channels and personas this sandbox does not have).
const stillAutomations = async (services: Services): Promise<DefinitionAction | undefined> => {
    const enabled = (await services.automations.list().catch(() => [])).filter((automation) => automation.enabled);
    if (enabled.length === 0) {
        return undefined;
    }
    for (const automation of enabled) {
        await services.automations.setEnabled(automation.id, false).catch(() => undefined);
    }
    return {
        subject: "Turn on the automations you want",
        detail: `${enabled.length} automation${enabled.length === 1 ? "" : "s"} arrived with the workspace and ${enabled.length === 1 ? "is" : "are"} switched OFF, because the scheduler fires enabled ones unattended: ${enabled.map((automation) => automation.id).join(", ")}. Enable the ones you want on the Automations view.`,
    };
};

// Workspace extensions: their code runs in the extension backend the moment they are enabled, and an ABSENT
// enablement entry means enabled (extension-enablement.ts), so arriving quietly is arriving switched on.
const stillExtensions = async (services: Services): Promise<DefinitionAction | undefined> => {
    const root = workspaceExtensionsRoot(services.workspace.root);
    const names = await readdir(root, { withFileTypes: true })
        .then((entries) => entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name))
        .catch(() => []);
    const ids: string[] = [];
    for (const name of names.toSorted()) {
        const parsed = await parseExtensionManifest(join(root, name));
        if ("manifest" in parsed) {
            ids.push(extensionIdOf(parsed.manifest));
        }
    }
    if (ids.length === 0) {
        return undefined;
    }
    for (const id of ids) {
        await writeExtensionEnablement(services.workspace.root, id, false).catch(() => undefined);
    }
    return {
        subject: "Enable the workspace extensions you trust",
        detail: `${ids.length} workspace extension${ids.length === 1 ? "" : "s"} arrived with the workspace and ${ids.length === 1 ? "is" : "are"} switched OFF, because an extension's code runs in this sandbox once it is on: ${ids.join(", ")}. Turn on the ones you trust on the Extensions view.`,
    };
};

// The three, in one pass, returning the lines the report owes the owner for whatever it actually turned off.
export const neutralizeWorkspaceArrival = async (
    services: Services,
    options: { readonly overlayHandledBySection: boolean },
): Promise<DefinitionAction[]> =>
    [await gateOverlay(services, options.overlayHandledBySection), await stillAutomations(services), await stillExtensions(services)].filter(
        (action): action is DefinitionAction => action !== undefined,
    );

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
            throw new WorkspaceRemoteError(`${host.host} refused to create "${name}": ${response.status} ${await response.text().catch(() => "")}`.trim());
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
        throw new WorkspaceRemoteError(`${host.host} refused to create "${name}": ${response.status} ${await response.text().catch(() => "")}`.trim());
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
            throw new WorkspaceRemoteError("no github or gitlab account is connected, so there is nowhere to create the repository; connect one, or paste a URL you made yourself");
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
