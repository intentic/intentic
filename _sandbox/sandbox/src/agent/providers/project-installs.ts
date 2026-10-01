import { undefinedIfMissing } from "@intentic/base/errors";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "@intentic/base/fs";
import type { AgentEvent, ProjectInstallMode } from "@intentic/sandbox-contract";
import type { ParkedCards } from "../../conversations/actor/parked-cards.js";
import { inWorktree, type IsolationPlan, type TurnPlacement } from "../../conversations/worktrees/isolation.js";
import { opt } from "../../opt.js";
import { agentCommand, classifyImageInstalls, type ProjectInstall, projectInstallsOf } from "./agent-installs.js";

// An agent's own project install is judged by where it writes, not by being an install, and judged in one place for
// every runtime: the command gate (guard/command-guard.ts) asks this before anything else, whether the command came
// through Claude Code's hook, Codex's approval request or Cursor's shell hook. An isolated turn's `node_modules` is an
// overlay whose upper layer is the conversation's own (kept until it is archived), and a project that exists only on
// its branch installs into its own worktree: nobody else reads either, so the install just runs. Only a main-tree turn
// writes the tree every conversation reads, and that one takes the heavy table's install lane, the lane the daemon's
// own installs take (heavy-rules.cjs `dependency-install`), so two never run at once. What lasts is settled at the
// land: the manifest and lockfile travel with the work, the review lists what it adds, and the reconciler installs it
// in the main tree. The owner's `projectInstalls` setting only says whether a person is asked, and a person's "allow
// for this conversation" is kept (personas/conversation-grants.ts), never held in memory only.

const execFileAsync = promisify(execFile);

// Where this turn's install writes. `private`: overlays over the main tree's dirs, the worktree's own elsewhere.
// `mirrored`: an isolated turn without a namespace, whose `node_modules` are symlinks into the main tree until detached.
// `shared`: the main tree itself.
export type InstallPlacement =
    | { readonly kind: "private"; readonly plan: IsolationPlan }
    | { readonly kind: "mirrored"; readonly plan: IsolationPlan }
    | { readonly kind: "shared" };

export const installPlacementOf = (isolation: TurnPlacement | undefined): InstallPlacement =>
    isolation === undefined ? { kind: "shared" } : { kind: isolation.anchor === undefined ? "mirrored" : "private", plan: isolation.plan };

// "Allow installs for this conversation", bound to one conversation: read at every install, so a yes given on this
// turn's card holds for its next install, and a yes taken back on the Grants page asks again from the next one.
export interface InstallGrants {
    readonly has: () => Promise<boolean>;
    readonly add: () => Promise<void>;
}

// A conversation's grant as the kept store holds it; `by` is whoever answered, when the turn knows.
export const installGrantsOf = (
    store: {
        readonly installsAllowed: (id: string) => Promise<boolean>;
        readonly allowInstalls: (id: string, by: string | undefined) => Promise<void>;
    },
    conversationId: string,
    by?: string,
): InstallGrants => ({
    has: () => store.installsAllowed(conversationId),
    add: () => store.allowInstalls(conversationId, by),
});

// What a turn's gate knows about its installs; every runtime's gate is built with the same one (turn-safety.ts).
export interface ProjectInstallGate {
    readonly placement: InstallPlacement;
    // The workspace root as the agent names it, which the note's project names are relative to.
    readonly root: string;
    // Absent reads as automatic, the shipped default.
    readonly mode: ProjectInstallMode | undefined;
    // The persona's own authority (files write and a shell); without it nothing is asked, only refused.
    readonly canInstall: boolean;
    // Absent for a turn with no conversation to hold a grant; its card then offers no "for this conversation".
    readonly grants: InstallGrants | undefined;
    // The rule itself (PROJECT_INSTALL_RULE), carried with what it judges by: the gate applying it lives in guard/, which
    // agent/ already imports, so guard/command-guard.ts reaches it through this field instead of importing back.
    readonly rule: ProjectInstallRule;
}

// How a shell command is read for installs and a project install decided: agent-installs.ts's readers and the consult
// below, as the one value every gate carries.
export interface ProjectInstallRule {
    readonly agentCommand: typeof agentCommand;
    readonly classifyImageInstalls: typeof classifyImageInstalls;
    readonly projectInstallsOf: typeof projectInstallsOf;
    readonly consult: typeof consultProjectInstall;
}

// How the gate asks: the card it parks on, the turn's signal a parked card settles with, and whether this runtime can
// pause at all.
export interface InstallAsking {
    readonly cards: Pick<ParkedCards, "create"> | undefined;
    readonly signal: AbortSignal;
    readonly canPark: boolean;
}

export type ProjectInstallVerdict =
    // `note` says where the install writes and what lasts of it; `unprepared`, what could not be set up for it.
    { readonly allow: true; readonly note: string; readonly unprepared: readonly string[] } | { readonly allow: false; readonly reason: string };

type AskAnswer = { readonly allow: true } | { readonly allow: false; readonly reason: string };

// Said once per turn with the first install, so the model knows its install is real and what lasts of it.
const PRIVATE_NOTE =
    "This install writes to this conversation's own copy of the tree: nobody else's turn reads it, and it lasts as long " +
    "as the conversation. The manifest and lockfile it changes land with the rest of the work; the owner sees the " +
    "dependencies it adds in the review, and the daemon installs them in the main tree after the land.";
const SHARED_NOTE =
    "This turn works in the main tree, so the install takes the sandbox's install lane: it waits for any other install " +
    "in progress (the daemon's own included) and then runs here, for every conversation.";

const LOCKFILES = [
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "uv.lock",
    "poetry.lock",
    "Pipfile.lock",
];
const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "Pipfile"];

const present = async (path: string): Promise<boolean> =>
    stat(path).then(
        () => true,
        () => false,
    );

// The directory an install really works on: the nearest one up holding a lockfile or workspace file (pnpm installs a
// whole workspace from any package inside it), else the nearest manifest, else where it was run. Never above `ceiling`.
export const installRootOf = async (dir: string, ceiling: string): Promise<string> => {
    let manifest: string | undefined;
    for (let current = dir; ; current = dirname(current)) {
        if ((await Promise.all(LOCKFILES.map((name) => present(join(current, name))))).some(Boolean)) {
            return current;
        }
        if (manifest === undefined && (await Promise.all(MANIFESTS.map((name) => present(join(current, name))))).some(Boolean)) {
            manifest = current;
        }
        if (current === ceiling || dirname(current) === current || !`${current}${sep}`.startsWith(`${ceiling}${sep}`)) {
            return manifest ?? dir;
        }
    }
};

const git = async (cwd: string, args: readonly string[]): Promise<string> => (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();

const ignored = async (cwd: string, path: string): Promise<boolean> =>
    execFileAsync("git", ["-C", cwd, "check-ignore", "-q", "--", path]).then(
        () => true,
        () => false,
    );

const nearestExisting = async (path: string): Promise<string> => {
    for (let current = path; ; current = dirname(current)) {
        if ((await present(current)) || dirname(current) === current) {
            return current;
        }
    }
};

const EXCLUDE_NOTE = "# intentic: dependency dirs a conversation installed into a project its branch created.";

// The directory each ecosystem installs into, and how far down a workspace repeats it.
const INSTALL_DIRS = {
    node: { name: "node_modules", nested: true },
    python: { name: ".venv", nested: false },
} as const satisfies Record<ProjectInstall["ecosystem"], { readonly name: string; readonly nested: boolean }>;

// The land commits what git does not ignore, and a project the branch created may have no `.gitignore` of its own:
// its fresh `node_modules` would ride onto the branch. Excluded in the repo's own info/exclude, anchored to the
// project, and only where nothing already ignores it; git reads that file for every worktree, the main one included,
// so the main tree's install after the land stays out of `git status` too.
export const ensureInstallDirIgnored = async (root: string, ecosystem: ProjectInstall["ecosystem"]): Promise<void> => {
    const { name, nested } = INSTALL_DIRS[ecosystem];
    // A line like `mkdir app && cd app && npm install x` names a directory that does not exist yet: git is asked from
    // the nearest one that does, about the path the install will create.
    const standing = await nearestExisting(root);
    if (await ignored(standing, join(relative(standing, root), `${name}/`))) {
        return;
    }
    const top = await git(standing, ["rev-parse", "--show-toplevel"]);
    const common = resolve(standing, await git(standing, ["rev-parse", "--git-common-dir"]));
    const rel = relative(top, root).split(sep).join("/");
    const pattern = rel === "" ? `/**/${name}/` : nested ? `/${rel}/**/${name}/` : `/${rel}/${name}/`;
    const file = join(common, "info", "exclude");
    // A repo with no exclude file yet gets one; one that cannot be read throws, and the owner's own lines stay as they are.
    const current = (await present(file)) ? await readFile(file, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === pattern)) {
        return;
    }
    const kept = current.replace(/\n+$/, "");
    const note = current.includes(EXCLUDE_NOTE) ? [] : [EXCLUDE_NOTE];
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, [...(kept === "" ? [] : [kept]), ...note, pattern, ""].join("\n"));
};

// Without a namespace an isolated turn's `node_modules` are symlinks into the main tree, so an install would write
// straight through them. Each link under the install root becomes an empty directory of the worktree's own first; the
// install then fills it, and the mirror pass leaves a populated directory alone (worktrees.ts linkMirrors). The anchored
// exclude line the link was covered by covers the directory too.
export const detachMirrors = async (plan: IsolationPlan, root: string): Promise<string[]> => {
    const rel = relative(plan.worktree, root).split(sep).join("/");
    const under = plan.mirrors.filter(
        (mirror) =>
            (basename(mirror) === "node_modules" || basename(mirror) === ".venv") && (rel === "" || mirror === rel || mirror.startsWith(`${rel}/`)),
    );
    const detached: string[] = [];
    for (const mirror of under) {
        const link = join(plan.worktree, mirror);
        if ((await lstat(link).catch(undefinedIfMissing))?.isSymbolicLink() !== true) {
            continue;
        }
        await rm(link, { force: true });
        await mkdir(link, { recursive: true });
        detached.push(mirror);
    }
    return detached;
};

// Makes the install's writes land where the placement says they should, before it runs. Best-effort per install: the
// install runs anyway, and what could not be prepared is said to the model, which can fix it with one `.gitignore`
// line, rather than to a log nobody reads mid-turn.
const prepare = async (placement: InstallPlacement, installs: readonly ProjectInstall[]): Promise<string[]> => {
    if (placement.kind === "shared") {
        return [];
    }
    const unprepared: string[] = [];
    for (const install of installs) {
        try {
            const dir = inWorktree(install.dir, placement.plan);
            // Outside the conversation's tree (a scratch dir, /tmp): nothing of anyone else's to protect.
            if (dir !== placement.plan.worktree && !dir.startsWith(`${placement.plan.worktree}/`)) {
                continue;
            }
            const root = await installRootOf(dir, placement.plan.worktree);
            if (placement.kind === "mirrored") {
                await detachMirrors(placement.plan, root);
            }
            await ensureInstallDirIgnored(root, install.ecosystem);
        } catch {
            unprepared.push(
                `Could not keep \`${INSTALL_DIRS[install.ecosystem].name}\` under ${install.dir} out of git by itself: add it to that ` +
                    `project's \`.gitignore\` before the work lands, or the land will carry it.`,
            );
        }
    }
    return unprepared;
};

const CANNOT_PARK =
    "The owner asks to approve project installs, and this agent cannot pause to ask. Do not retry. Add the dependency " +
    "to the manifest if the task needs it (it installs once the work lands), and say plainly what you could not run.";

// How much of the command the card shows; the command gate's own bound.
const SHOWN = 400;

const whereItLands = (placement: InstallPlacement): string =>
    placement.kind === "shared"
        ? "It runs in the main tree, which every conversation reads."
        : "It installs into this conversation's own copy of the tree; nobody else's work sees it.";

// The card: the same permission ask the command gate raises, so the chat renders and answers it the same way. It waits
// however long the answer takes, whoever is or is not watching: an install nobody has answered yet is not a refusal.
async function* askOwner(command: string, gate: ProjectInstallGate, asking: InstallAsking): AsyncGenerator<AgentEvent, AskAnswer> {
    const { cards } = asking;
    if (cards === undefined || !asking.canPark) {
        return { allow: false, reason: CANNOT_PARK };
    }
    const { id, wait } = cards.create("permission", {
        kind: "permission",
        requestId: "",
        decision: "deny",
        feedback: "The turn ended before the owner answered.",
    });
    yield {
        kind: "permission",
        requestId: id,
        toolName: "Bash",
        title: "Install project dependencies",
        displayName: "Run install",
        explain: whereItLands(gate.placement),
        program: { text: command.slice(0, SHOWN), language: "bash", truncated: command.length > SHOWN, spans: [] },
        // Only a conversation can hold the grant it offers.
        ...opt("alwaysLabel", gate.grants === undefined ? undefined : "Allow installs for this conversation"),
    };
    const { reply, resolved } = await wait(asking.signal);
    yield resolved;
    if (reply.decision === "deny") {
        return {
            allow: false,
            reason:
                reply.feedback?.trim() ||
                "The owner declined this install. Do not run it another way. Add the dependency to the manifest if the task " +
                    "needs it, and wait for them to say how to proceed.",
        };
    }
    if (reply.decision === "always") {
        await gate.grants?.add();
    }
    return { allow: true };
}

// The projects an install works on, as the note names them: workspace-relative, the root as an empty string.
const projectsOf = async (placement: InstallPlacement, root: string, installs: readonly ProjectInstall[]): Promise<string[]> => {
    const named = new Set<string>();
    for (const install of installs) {
        const onDisk = placement.kind === "shared" ? install.dir : inWorktree(install.dir, placement.plan);
        const ceiling = placement.kind === "shared" ? root : placement.plan.worktree;
        if (onDisk !== ceiling && !onDisk.startsWith(`${ceiling}/`)) {
            continue;
        }
        const project = await installRootOf(onDisk, ceiling);
        named.add(relative(ceiling, project).split(sep).join("/"));
    }
    return [...named];
};

// One install command's consult, driven by the command gate. The persona's authority first, the owner's setting
// second, and only then where it lands, which decides what is prepared, never whether it runs. Allowed, it tells the
// chat as it starts.
export async function* consultProjectInstall(
    command: string,
    installs: readonly ProjectInstall[],
    gate: ProjectInstallGate,
    asking: InstallAsking,
): AsyncGenerator<AgentEvent, ProjectInstallVerdict> {
    if (!gate.canInstall) {
        return {
            allow: false,
            reason:
                "This persona cannot change the workspace, so it cannot install dependencies. Do not retry; say what the task " +
                "needs installed and ask the owner.",
        };
    }
    const mode = gate.mode ?? "automatic";
    if (mode === "never") {
        return {
            allow: false,
            reason:
                "The owner has turned agent installs off for this sandbox. Do not retry or install another way. If the task " +
                "needs a dependency, add it to the manifest: it installs when the owner lands the work. Say plainly what you " +
                "could not run until then.",
        };
    }
    if (mode === "ask" && (await gate.grants?.has()) !== true) {
        const answer = yield* askOwner(command, gate, asking);
        if (!answer.allow) {
            return answer;
        }
    }
    const unprepared = await prepare(gate.placement, installs);
    yield {
        kind: "install",
        reach: gate.placement.kind === "shared" ? "main-tree" : "own-copy",
        projects: await projectsOf(gate.placement, gate.root, installs),
    };
    return { allow: true, note: gate.placement.kind === "shared" ? SHARED_NOTE : PRIVATE_NOTE, unprepared };
}

export const PROJECT_INSTALL_RULE: ProjectInstallRule = { agentCommand, classifyImageInstalls, projectInstallsOf, consult: consultProjectInstall };
