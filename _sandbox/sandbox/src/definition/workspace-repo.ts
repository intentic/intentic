import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { extensionIdOf } from "@intentic/extension-manifest";
import type {
    AutomationSchema,
    NeedsAction,
    DefinitionWorkspace,
    WorkspacePublish,
    WorkspacePublishResult,
    WorkspaceRemote,
} from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { isPublicPath } from "@intentic/workspace-ignore";
import { z } from "zod";
import { type GitHost, gitHostOf, githubHeaders } from "../capabilities/cli/git-access.js";
import { parseExtensionManifest, workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";
import { extensionEnablementDocument } from "../extensions/extension-enablement.js";
import { defaultBranchOf } from "../git/ops/publish-file.js";
import { pushBranch, remoteState } from "../git/remote/remote.js";
import { ROOT_BASELINE_CONFIG, ROOT_FRESH_CONFIG } from "../git/remote/root-repo.js";
import { AGENT_GIT_AUTHOR } from "../git-identity.js";
import { rootPathIsExcluded } from "../workspace/layout/git-layout.js";
import { type Conversion, isJsonObject } from "../store/evolution/conversions.js";
import type { DocumentSpec } from "../store/evolution/documents.js";
import { openDocument, openEntries } from "../store/open-document.js";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";
import { DEFINITION_SOURCES } from "./definition.js";

// Publishes /work and adopts a published workspace into a fresh one. The exclude list tracks only owner-authored
// content (notes, skills, personas, automations, approvals, extensions). A foreign tree is preflighted and rewritten
// inert in a detached worktree before it ever touches /work; nothing unsafe is checked out live.

export class WorkspaceRemoteError extends Error {}

// The automations document lives a layer above this one (automations/), so the caller that may import it hands it in:
// the staged file is then read the way the scheduler's own store reads it, its conversions and all.
export type AutomationsDocument = DocumentSpec<typeof AutomationSchema, readonly Conversion[], readonly string[], "entries", false>;

export interface AdoptionDocuments {
    readonly automations: AutomationsDocument;
}

// Keeps git's full stderr, not just the last line: a checkout refusal names which files block it in the middle of the
// message.
const gitRefusal = (error: unknown, fallback: string): string => {
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : errorMessage(error);
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    return lines.length === 0 ? fallback : lines.join(" ");
};

// Connected github/gitlab accounts, in the order a publish would try them.
const gitHosts = async (services: Services): Promise<GitHost[]> =>
    (await services.capabilities.list()).flatMap((capability) => {
        if (capability.kind !== "cli" || (capability.config.provider !== "github" && capability.config.provider !== "gitlab")) {
            return [];
        }
        try {
            return [gitHostOf(capability.config)];
        } catch {
            // An unparseable gitlab instance url publishes nowhere; it fails its own probe.
            return [];
        }
    });

// A repo's remote URL, or undefined; every failure here (no remote, unreadable URL) is an ordinary state, not an
// exception.
const remoteUrlOf = async (dir: string, git: GitRunner): Promise<{ remote?: string; branch?: string }> => {
    const state = await remoteState(dir, {}, git);
    const branch = state.branch === undefined || state.branch === "" ? undefined : state.branch;
    if (state.remote === undefined) {
        return branch === undefined ? {} : { branch };
    }
    const url = (await git(dir, ["remote", "get-url", state.remote]).catch(() => undefined))?.stdout.trim();
    return { ...(url === undefined || url === "" ? {} : { remote: url }), ...(branch === undefined ? {} : { branch }) };
};

// Whether /work is already published, the one fact the apply's applicability turns on.
export const workspaceRemoteUrl = async (root: string, git: GitRunner = defaultGit): Promise<string | undefined> =>
    (await remoteUrlOf(root, git)).remote;

// Where /work stands and could go: published or not, and which hosts could publish it. Read-only.
export const workspaceRemote = async (services: Services, git: GitRunner = defaultGit): Promise<WorkspaceRemote> => ({
    ...(await remoteUrlOf(services.workspace.root, git)),
    hosts: (await gitHosts(services)).map((host) => host.host),
});

// Whether a definition may materialize a workspace here: the exact baseline sha (in protected git config) must match
// HEAD with no worktree changes, or an unborn repo must carry the fresh marker. Commit count alone is not provenance.
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

// Refuses anything the root's own exclude list would (even if the foreign repo force-added it), any symlink or gitlink
// (an escape or an uninspected nested repo), and a top-level public/ (serves files on creation).
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

const optionalFile = (path: string): Promise<Buffer | undefined> => readFile(path).catch(undefinedIfMissing);

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
const EXTENSION_ENABLEMENT = extensionEnablementDocument.path;

// An entry without the key at a dotted path, the rest of it as written.
const withoutKey = (value: unknown, [head, ...rest]: readonly string[]): unknown => {
    if (!isJsonObject(value) || head === undefined || !Object.hasOwn(value, head)) {
        return value;
    }
    if (rest.length > 0) {
        return { ...value, [head]: withoutKey(value[head], rest) };
    }
    const { [head]: _moved, ...kept } = value;
    return kept;
};

// What a structural step moves out of the document into a home of its own (an old webhook token into the door store)
// never arrives with a workspace. The store keeps every key this build does not know on a write, and the step would
// move such a key into place on the target's next boot, putting the source's credential to work there. Read after the
// document has read the file whole, so it is a list of JSON entries.
const dropMovedKeys = async (root: string, document: AutomationsDocument): Promise<void> => {
    const text = await optionalFile(join(root, document.path));
    if (text === undefined || document.movedByStep.length === 0) {
        return;
    }
    const entries = JSON.parse(text.toString("utf8")) as unknown[];
    const kept = entries.map((entry) => document.movedByStep.reduce((current, key) => withoutKey(current, key.split(".")), entry));
    if (JSON.stringify(kept) !== JSON.stringify(entries)) {
        await replaceFile(root, document.path, `${JSON.stringify(kept, null, 2)}\n`);
    }
};

// The staged automations, read through their document as the scheduler's store reads them (an older shape converts),
// and written back switched off with every key this build does not know kept, except what a step moves elsewhere.
// Refused whole when the file, or any entry in it, cannot be read: such an entry would be written back as it stands,
// perhaps enabled, for a later build that can read it to fire unattended.
const stillAutomations = async (root: string, document: AutomationsDocument): Promise<NeedsAction | undefined> => {
    const file = openEntries(document, join(root, document.path), { strict: true, onUnreadable: "refuse" });
    const state = await file.state();
    if (state.unreadable) {
        throw new WorkspaceRemoteError(`${document.path} cannot arrive safely: ${state.detail}`);
    }
    const enabled = state.value.filter((automation) => automation.enabled);
    if (enabled.length > 0) {
        await file.update((automations) => automations.map((automation) => ({ ...automation, enabled: false })));
    }
    await dropMovedKeys(root, document);
    if (enabled.length === 0) {
        return undefined;
    }
    return {
        subject: "Turn on the automations you want",
        detail: `${enabled.length} automation${enabled.length === 1 ? "" : "s"} arrived with the workspace and ${enabled.length === 1 ? "is" : "are"} switched OFF, because the scheduler fires enabled ones unattended: ${enabled.map((automation) => automation.id).join(", ")}. Enable the ones you want on the Automations view.`,
    };
};

const stillExtensions = async (
    root: string,
    targetEnablement: Readonly<Record<string, boolean>>,
    targetHadEnablement: boolean,
): Promise<NeedsAction | undefined> => {
    const extensionsRoot = workspaceExtensionsRoot(root);
    const entries = (await readdir(extensionsRoot, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
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

const gateOverlay = async (root: string, incoming: Buffer | undefined, handledBySection: boolean): Promise<NeedsAction | undefined> => {
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

export interface AdoptionOptions extends AdoptionDocuments {
    readonly overlayHandledBySection: boolean;
}

const safeWorkspaceCommit = async (
    services: Services,
    commit: string,
    options: AdoptionOptions,
    git: GitRunner,
): Promise<{ readonly commit: string; readonly actions: NeedsAction[] }> => {
    const root = services.workspace.root;
    const targetSources = new Map<string, Buffer | undefined>();
    for (const path of DEFINITION_SOURCES) {
        targetSources.set(path, await optionalFile(join(root, path)));
    }
    const targetEnablementBytes = await optionalFile(join(root, EXTENSION_ENABLEMENT));
    // Through its document, as the extension host reads it; switches this build cannot read refuse the arrival rather
    // than reading as none set, which would turn every extension the target had switched off back on.
    const targetEnablement = await openDocument(extensionEnablementDocument, join(root, EXTENSION_ENABLEMENT), { fallback: () => ({}) }).state();
    if (targetEnablement.unreadable) {
        throw new WorkspaceRemoteError(`the target's ${EXTENSION_ENABLEMENT} cannot arrive safely: ${targetEnablement.detail}`);
    }

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
        // The remote's switch file never overrides extensions already installed in the target.
        await replaceFile(stage, EXTENSION_ENABLEMENT, undefined);
        const actions = [
            await gateOverlay(stage, incomingOverlay, options.overlayHandledBySection),
            await stillAutomations(stage, options.automations),
            await stillExtensions(stage, targetEnablement.value, targetEnablementBytes !== undefined),
        ].filter((action): action is NeedsAction => action !== undefined);
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

// Never checks the foreign tree out live: only a preflighted, inert commit is checked out, with ignored-overwrites
// forbidden. A mixed reset then moves the branch to the real remote commit, keeping the rewrites local-only.
export const adoptWorkspaceRemote = async (
    services: Services,
    workspace: DefinitionWorkspace,
    options: AdoptionOptions,
    git: GitRunner = defaultGit,
): Promise<{ readonly branch: string; readonly actions: NeedsAction[] }> => {
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
        // Moves HEAD and index to the real remote commit without touching the already-safe worktree.
        await git(root, ["reset", "--mixed", remoteCommit]);
        await git(root, ["config", "--unset-all", ROOT_FRESH_CONFIG]).catch(() => undefined);
        await git(root, ["config", "--unset-all", ROOT_BASELINE_CONFIG]).catch(() => undefined);
        // Upstream tracking is a convenience, not required for a correct checkout.
        await git(root, ["branch", `--set-upstream-to=origin/${branch}`, branch]).catch(() => undefined);
        return { branch, actions: prepared.actions };
    } catch (error) {
        if (!checkedOut) {
            await git(root, ["remote", "remove", "origin"]).catch(() => undefined);
        }
        throw error instanceof WorkspaceRemoteError ? error : new WorkspaceRemoteError(gitRefusal(error, "could not check out the workspace"));
    }
};

// Publishing: the half a definition cannot do for itself, since naming a remote requires one to exist; its own
// owner-gated route, since publishing is outward and deriving stays read-only. What travels is root's exclude list
// already: nested repos, the reference shelf, .intentic/local and /secrets, .env*, junk dirs.

// What a failed lookup logs: the status github answered with, or why nothing came back at all.
export type LoginLookupWarn = (fields: { readonly status?: number; readonly err?: string }, message: string) => void;
type Fetcher = (url: string, init: { readonly headers: Record<string, string> }) => Promise<Response>;
const GithubUserSchema = z.object({ login: z.string() });

// The login the token authenticates as, to tell the owner's own account from an organization. A lookup that fails (a
// token that cannot read its user, a network error, an answer that is not JSON) is logged with its reason and read as
// no login: the owner is then taken for an organization, whose endpoint answers for itself, and publishing goes on
// rather than stopping at a question it did not need answered.
export const githubLogin = async (host: Pick<GitHost, "apiBase" | "token">, warn: LoginLookupWarn, fetcher: Fetcher = fetch): Promise<string | undefined> => {
    const unread = "publish: github would not say which account this token is, so the owner is taken for an organization";
    try {
        const user = await fetcher(`${host.apiBase}/user`, { headers: githubHeaders(host.token) });
        if (!user.ok) {
            warn({ status: user.status }, unread);
            return undefined;
        }
        return GithubUserSchema.safeParse(await user.json()).data?.login;
    } catch (error) {
        warn({ err: errorMessage(error) }, unread);
        return undefined;
    }
};

const created = async (host: GitHost, name: string, owner: string | undefined, warn: LoginLookupWarn): Promise<string> => {
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
    // github: an owner other than the authenticated user is an organization, with its own endpoint. No owner named is
    // the token's own account, with nothing to look up.
    const login = owner === undefined ? undefined : await githubLogin(host, warn);
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

// Repo name derived from the sandbox's name, recognizable in a repo list; empty or unusable falls back to a fixed name.
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
        remote = await created(host, repoNameFrom(input.name ?? services.config.sandbox.name), input.owner, (fields, message) => services.logger.warn(fields, message));
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
        // Removed on a failed push; otherwise deriveDefinition would claim a [workspace] nobody can clone.
        await git(root, ["remote", "remove", "origin"]).catch(() => undefined);
        throw new WorkspaceRemoteError(pushed.reason);
    }
    return { remote, branch, created: supplied === "" };
};
