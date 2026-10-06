import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { extensionIdOf } from "@intentic/extension-manifest";
import type { Capability } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { extensionDir, extensionRootOf, extensionsRoot, readExtensionManifest } from "../../../capabilities/extension-dirs.js";
import type { Services } from "../../../composition.js";
import { headSha } from "../../../git/changes/changes.js";
import { scratchOf } from "../../../git/changes/scratch.js";
import { composeReach, type ReachFrames, type StrandedClone } from "../../verification/agent-reach.js";

// The half of a turn's reach (agent-reach.ts) only git can tell, read as the turn closes: what changed in an installed
// extension's checkout while it ran, edit tools and shell alike, and the clones it left work in inside its own copy.
// Both are read where the daemon keeps them; nothing here runs inside the turn's namespace.

// How many dirty files of one install are looked at closely enough to see a second edit to a file already dirty.
const SIGNED_FILES_MAX = 2_000;

// One install as git reads it: where its HEAD is, and its dirty files with when and how big each one is.
export interface InstallState {
    readonly head: string | undefined;
    readonly status: string;
}

// Every install's state, keyed by its folder under .intentic/local/extensions.
export type InstallSnapshot = ReadonlyMap<string, InstallState>;

// Status entries are `XY path`, a rename or copy carrying its source as the next entry.
const dirtyFiles = (porcelain: string): string[] => {
    const entries = porcelain.split("\0").filter((entry) => entry !== "");
    const files: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index] as string;
        files.push(entry.slice(3));
        if (/^[RC]|^.[RC]/.test(entry)) {
            index += 1;
        }
    }
    return files;
};

const installState = async (dir: string, git: GitRunner): Promise<InstallState> => {
    const head = await headSha(dir, git);
    const { stdout } = await git(dir, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall"]);
    // Size and mtime of each dirty file, so a file edited again while already dirty still reads as a change.
    const signed = await Promise.all(
        dirtyFiles(stdout)
            .slice(0, SIGNED_FILES_MAX)
            .map(async (file) => {
                const stat = await lstat(join(dir, file)).catch(() => undefined);
                return stat === undefined ? `${file}:gone` : `${file}:${stat.size}:${stat.mtimeMs}`;
            }),
    );
    return { head, status: stdout === "" ? "" : `${stdout}\n${signed.join("\n")}` };
};

// Every install under `root` that git can read; one it cannot (half-cloned, not a checkout) is left out.
export const snapshotInstalls = async (root: string, git: GitRunner = defaultGit): Promise<InstallSnapshot> => {
    const base = extensionsRoot(root);
    const dirs = await readdir(base, { withFileTypes: true }).catch(() => []);
    const read = await Promise.all(
        dirs
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map(async (entry) => {
                const state = await installState(join(base, entry.name), git).catch(() => undefined);
                return state === undefined ? [] : [[entry.name, state] as const];
            }),
    );
    return new Map(read.flat());
};

// The installs this turn left changed: each one that moved between the two readings (a new one counts) and still
// stands apart from what was installed, dirty or off its pinned commit. One the turn put back reads as nothing, and so
// does one an update replaced while it ran, since that lands clean on its new pin.
export const changedInstalls = (before: InstallSnapshot, after: InstallSnapshot, pins: ReadonlyMap<string, string>): string[] =>
    [...after].flatMap(([dir, state]) => {
        const was = before.get(dir);
        const moved = was === undefined || was.head !== state.head || was.status !== state.status;
        const pin = pins.get(dir);
        const apart = state.status !== "" || pin === undefined || state.head !== pin;
        return moved && apart ? [dir] : [];
    });

// The manifest id an install answers to, its folder name when its manifest cannot be read.
const extensionNameOf = async (root: string, dir: string, path: string | undefined): Promise<string> => {
    const manifest = await readExtensionManifest(extensionRootOf(extensionDir(root, dir), path)).catch(() => undefined);
    return manifest === undefined ? dir : extensionIdOf(manifest);
};

const count = async (git: GitRunner, dir: string, args: readonly string[]): Promise<number> => Number((await git(dir, args)).stdout.trim()) || 0;

// Commits the clone holds that its upstream does not, or that no remote has when it follows none.
const unpushedIn = async (dir: string, git: GitRunner): Promise<number> => {
    if ((await headSha(dir, git)) === undefined) {
        return 0;
    }
    return count(git, dir, ["rev-list", "--count", "@{upstream}..HEAD"]).catch(() =>
        count(git, dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]),
    );
};

// Clones of its own inside the turn's checkouts holding work a land will never carry: files changed in them, or commits
// nobody else has. `repos` are the checkouts as the daemon keeps them, each with its folder in the workspace (`root` is
// the workspace's own); `dir` comes back relative to the turn's copy of the workspace.
export const strandedClones = async (
    repos: readonly { readonly repo: string; readonly dir: string }[],
    git: GitRunner = defaultGit,
): Promise<StrandedClone[]> => {
    const found = await Promise.all(
        repos.map(async ({ repo, dir }) => {
            // As a root reads it in every repo: a clone a project repo would only keep as a gitlink lands no more of itself.
            const scratch = await scratchOf(dir, { root: true, container: false }, git).catch(() => []);
            const clones = await Promise.all(
                scratch
                    .filter((entry) => entry.reason === "checkout")
                    .map(async (entry): Promise<StrandedClone | undefined> => {
                        const clone = join(dir, entry.path);
                        const [status, unpushed] = await Promise.all([
                            git(clone, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall"]).then(
                                ({ stdout }) => dirtyFiles(stdout).length,
                            ),
                            unpushedIn(clone, git),
                        ]).catch(() => [0, 0]);
                        if (status === 0 && unpushed === 0) {
                            return undefined;
                        }
                        const within = entry.path.replace(/\/$/, "");
                        return { dir: repo === "root" ? within : `${repo}/${within}`, uncommitted: status, unpushed };
                    }),
            );
            return clones.filter((clone): clone is StrandedClone => clone !== undefined);
        }),
    );
    return found.flat();
};

// One turn's reach, from its open to its close: the installs read as it opens, the frames' half handed over as it
// settles, and both halves composed and noted on the conversation as it closes, ahead of the settle that files it.
export interface ReachWatch {
    // Starts reading the installs, answering once the reading is in. A placement does not wait for it: the turn's first
    // tool call is seconds behind its open, a read is a few git calls, and a turn's start is not made to wait on them.
    readonly open: () => Promise<void>;
    readonly framed: (frames: ReachFrames) => void;
    // `repos` are the turn's own checkouts, none on the main tree, which has no clone of its own to strand.
    readonly close: (repos: readonly { readonly repo: string; readonly dir: string }[]) => Promise<void>;
}

const NOTHING_FRAMED: ReachFrames = { live: [], published: [] };

const pinsOf = (capabilities: readonly Capability[]): Map<string, { readonly ref: string; readonly path: string | undefined }> =>
    new Map(
        capabilities.flatMap((capability) =>
            capability.kind === "extension" ? [[capability.id, { ref: capability.config.ref, path: capability.config.path }] as const] : [],
        ),
    );

// Never throws: a reach it could not read is logged and noted as nothing, which clears the card's last one.
export const reachWatch = (
    deps: Pick<Services, "workspace" | "capabilities" | "conversations" | "logger">,
    conversationId: string,
    git: GitRunner = defaultGit,
): ReachWatch => {
    const root = deps.workspace.root;
    let opened: Promise<InstallSnapshot | undefined> = Promise.resolve(undefined);
    let framed = NOTHING_FRAMED;
    return {
        open: async () => {
            opened = snapshotInstalls(root, git).catch((error: unknown) => {
                deps.logger.debug({ err: error, id: conversationId }, "agents: reading the installed extensions as a turn opens failed");
                return undefined;
            });
            await opened;
        },
        framed: (frames) => {
            framed = frames;
        },
        close: async (repos) => {
            const at = Date.now();
            try {
                const before = await opened;
                const after = before === undefined ? new Map<string, InstallState>() : await snapshotInstalls(root, git);
                const pins = pinsOf(await deps.capabilities.list());
                const changed = before === undefined ? [] : changedInstalls(before, after, new Map([...pins].map(([dir, pin]) => [dir, pin.ref])));
                const installs = await Promise.all(
                    changed.map(async (dir) => ({ dir, extension: await extensionNameOf(root, dir, pins.get(dir)?.path) })),
                );
                const stranded = await strandedClones(repos, git);
                const reach = composeReach({ framed, installs, covered: new Set(after.keys()), stranded }, at);
                deps.conversations.send(conversationId, { kind: "reach-noted", reach });
            } catch (error) {
                deps.logger.warn({ err: error, id: conversationId }, "agents: reading where a turn's work went failed");
                deps.conversations.send(conversationId, {
                    kind: "reach-noted",
                    reach: composeReach({ framed, installs: [], covered: new Set(), stranded: [] }, at),
                });
            }
        },
    };
};
