import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sleep } from "@intentic/base/async";
import { sdk } from "../../engines/claude-sdk.js";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import type { DependencyRequestOrigin } from "./dependency-origin.js";
import type { DependencyCoordinator } from "./reconcile-deps.js";
import { behindSummary, discoverProjects, type ProjectSetupStatus, type WorkspaceProject } from "../layout/workspace-setup.js";

// Dependency readiness, asked for rather than pushed on every turn: the rule lives in these tool descriptions (paid
// once, cached), the state is fetched by whoever wants it. An agent may run a project's install itself (the install
// hook, agent/providers/project-installs.ts, decides by where it writes); `install` is the other door, the daemon's
// own install of a main-tree project, run by the coordinator (reconcile-deps.ts) in the install lane and waited on.

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

// How long `install` waits for the daemon before answering "still installing": long enough for an ordinary install,
// short of any tool-call ceiling.
const DEFAULT_WAIT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 2_000;

export interface DepsToolDeps {
    readonly dependencies: Pick<DependencyCoordinator, "status" | "requestInstall">;
    readonly canInstall: boolean;
    readonly origin: DependencyRequestOrigin;
    // The conversation's own root worktree, daemon-side, when the turn is isolated: an install run there is private, and
    // a project its branch created is found there and nowhere else.
    readonly worktree?: string | undefined;
    // The turn's own signal: a wait ends with the turn.
    readonly signal?: AbortSignal | undefined;
    readonly waitMs?: number;
    readonly pollMs?: number;
}

// A project names itself by its directory; the root's manifest is "the workspace root", not empty string, matching the
// notices' own wording.
const where = (project: { readonly dir: string }): string => (project.dir === "" ? "the workspace root" : project.dir);

// What running the install yourself means here, in one clause.
const yourselfClause = (isolated: boolean): string =>
    isolated
        ? "it writes to this conversation's own copy of the tree, which no other conversation reads"
        : "it runs in the main tree, one install at a time with the daemon's own";

// One project's readiness as a sentence the model can act on; `ready` is stated explicitly: half the value of asking is
// confirming a project is fine, so a failure there is the model's own.
const line = (status: ProjectSetupStatus, canInstall: boolean, isolated: boolean): string => {
    switch (status.state) {
        case "ready":
            // `ready` differs per ecosystem: Node's is walked against the manifest, Python's `.venv` only confirms
            // setup happened, not that it matches what's declared.
            return status.recipe.ecosystem === "node"
                ? `${where(status)}: ready. Its type-checks, linters and tests mean what they say.`
                : `${where(status)}: ready — \`${status.recipe.marker}\` is there, which is the whole measurement. ` +
                      `Nothing walked it against ${status.recipe.evidence}, so an import that will not resolve can still be ` +
                      `the environment being behind rather than a mistake in the code: say so rather than editing working source to satisfy it.`;
        case "installing":
            return `${where(status)}: installing right now. Its checks will be trustworthy once that finishes; \`mcp__deps__install\` waits for it.`;
        case "stale":
            return (
                `${where(status)}, behind: ${behindSummary(status)}. Unresolved-import errors naming those, and failures ` +
                `tracing to those versions, are the install being behind, not a mistake in the code. The daemon is already ` +
                `repairing it; call \`mcp__deps__install\` for it to wait until it is done.`
            );
        case "needs-setup":
            return canInstall
                ? `${where(status)}: never installed. Run \`${status.recipe.command}\` in it (${yourselfClause(isolated)}), or call ` +
                      `\`mcp__deps__install\` to have the daemon install it in the main tree and wait for it.`
                : `${where(status)}, never installed. This persona cannot change the workspace, so ask the owner to install it.`;
        case "unsupported":
            return `${where(status)}: never installed, and \`${status.recipe.manager}\` is not in this sandbox. Nothing here can fix that; say so if it blocks the task.`;
    }
};

const standingRule = (canInstall: boolean, isolated: boolean): string =>
    canInstall
        ? `You may run a project's own install or add command yourself (\`pnpm add\`, \`npm install\`, \`uv sync\`): ${yourselfClause(isolated)}. ` +
          `The manifest and lockfile it changes land with the rest of your work, and the owner's review lists every dependency it adds.`
        : "This persona cannot install dependencies; ask the owner.";

// Projects that exist only on this conversation's branch, by the name `mcp__deps__status` would give them.
const branchOnly = async (worktree: string | undefined, known: readonly ProjectSetupStatus[]): Promise<WorkspaceProject[]> => {
    if (worktree === undefined) {
        return [];
    }
    const mine = await discoverProjects(worktree).catch((cause: unknown) => {
        console.warn("Could not discover branch projects", cause);
        return [];
    });
    return mine.filter((project) => !known.some((main) => main.dir === project.dir));
};

const branchOnlyLine = (project: WorkspaceProject): string =>
    `${where(project)}: exists only on this conversation's branch. Run \`${project.recipe.command}\` in it yourself: it installs into ` +
    `this conversation's own copy, and the daemon installs it in the main tree once the work lands.`;

type Settled = { readonly dir: string; readonly outcome: "ready" | "behind" | "waiting"; readonly status?: ProjectSetupStatus };

// Waits for the daemon's installs of `dirs`: each settles when it reads ready, or when it was seen installing and no
// longer is. One that never started by the deadline, or is still running, is `waiting`.
const settle = async (dirs: readonly string[], deps: DepsToolDeps): Promise<Settled[]> => {
    const deadline = Date.now() + (deps.waitMs ?? DEFAULT_WAIT_MS);
    const seenInstalling = new Set<string>();
    const done = new Map<string, Settled>();
    while (done.size < dirs.length && Date.now() < deadline && deps.signal?.aborted !== true) {
        const projects = await deps.dependencies.status();
        for (const dir of dirs.filter((each) => !done.has(each))) {
            const status = projects.find((project) => project.dir === dir);
            if (status === undefined) {
                continue;
            }
            if (status.state === "ready") {
                done.set(dir, { dir, outcome: "ready", status });
            } else if (status.state === "installing") {
                seenInstalling.add(dir);
            } else if (seenInstalling.has(dir)) {
                done.set(dir, { dir, outcome: "behind", status });
            }
        }
        if (done.size < dirs.length) {
            await sleep(deps.pollMs ?? DEFAULT_POLL_MS, { signal: deps.signal }).catch((cause: unknown) => {
                if (deps.signal?.aborted !== true) {
                    throw cause;
                }
            });
        }
    }
    return dirs.map((dir) => done.get(dir) ?? { dir, outcome: "waiting" });
};

const settledLine = (settled: Settled, deps: DepsToolDeps, isolated: boolean): string => {
    const name = where(settled);
    switch (settled.outcome) {
        case "ready":
            return isolated
                ? `${name}: installed in the main tree. This conversation reads it through its own layer; if an import still ` +
                      `fails here, run the project's install yourself: it writes to this conversation's own copy.`
                : `${name}: installed. Its checks mean what they say now.`;
        case "behind":
            return (
                `${name}: the daemon's install finished, but ${settled.status === undefined ? "the project is still behind" : line(settled.status, deps.canInstall, isolated)} ` +
                `Its log is in the project's install terminal. It is not retried until a manifest or lockfile changes.`
            );
        case "waiting":
            return (
                `${name}: still installing after the wait. Finish what else the task needs, say the verification is pending, ` +
                `and check \`mcp__deps__status\` before trusting its checks.`
            );
    }
};

// `status`: every project's readiness, and the standing rule about installing, in the description.
export const statusTool = (deps: DepsToolDeps) => {
    const isolated = deps.worktree !== undefined;
    return sdk().tool(
        "status",
        `Whether each project under /work actually has its declared dependencies installed. Call this when an import ` +
            `will not resolve, a test fails on a missing module, or before you trust a type-check: it tells you whether ` +
            `the failure is your code or an install that is behind. ${standingRule(deps.canInstall, isolated)}`,
        {},
        async () => {
            const projects = await deps.dependencies.status();
            const mine = await branchOnly(deps.worktree, projects);
            if (projects.length === 0 && mine.length === 0) {
                return ok("No projects with a package manifest were found under /work.");
            }
            const behind = projects.filter((project) => project.state !== "ready" && project.state !== "installing");
            // The summary must reflect the weakest measurement: one project only checked for presence keeps "a
            // failing import is your code" from being a claim nothing here verified.
            const unwalked = projects.some((project) => project.state === "ready" && project.recipe.ecosystem !== "node");
            return ok(
                [
                    ...projects.map((project) => line(project, deps.canInstall, isolated)),
                    ...mine.map(branchOnlyLine),
                    "",
                    behind.length === 0
                        ? unwalked
                            ? "Everything has been installed at least once. Where that was all that was measured, an import that will not " +
                              "resolve can still be the environment rather than the code."
                            : "Everything in the main tree is installed: a failing import there is a mistake in the code, not the tree."
                        : "Everything marked ready checks normally in the meantime.",
                ].join("\n"),
            );
        },
        // The drift repair status() may queue is the reconciler's own, run in the install lane.
        { annotations: toolAnnotations("read") },
    );
};

// `install`: the daemon's install of main-tree projects, waited on; a branch-only project is answered with its command.
export const installTool = (deps: DepsToolDeps) => {
    const isolated = deps.worktree !== undefined;
    return sdk().tool(
        "install",
        "Have the daemon install a main-tree project's dependencies, and wait for it (up to ten minutes). It runs " +
            "the project's own install in the install lane, one at a time with every other install, and answers with " +
            "the outcome. Use it for a project that was never set up or reads as behind; for a project on this " +
            "conversation's own branch, or to add a package, run the manager yourself.",
        {
            projects: z
                .array(z.string().max(500))
                .min(1)
                .max(50)
                .describe("Project directories as `mcp__deps__status` names them, e.g. `intentic`. Use an empty string for the workspace root."),
        },
        async ({ projects }) => {
            const result = await deps.dependencies.requestInstall(projects, deps.origin);
            const known = result.projects;
            const wanted = new Set(projects);
            const matched = known.filter((project) => wanted.has(project.dir));
            const unknownDirs = projects.filter((dir) => !known.some((project) => project.dir === dir));
            const mine = await branchOnly(deps.worktree, known);
            const installing = matched.filter((project) => project.state === "installing").map((project) => project.dir);
            const settled = await settle([...result.queued, ...installing], deps);
            return ok(
                [
                    ...settled.map((each) => settledLine(each, deps, isolated)),
                    ...matched.filter((project) => project.state === "ready").map((project) => line(project, deps.canInstall, isolated)),
                    ...matched
                        .filter((project) => project.state === "unsupported")
                        .map((project) => `Not installed: ${line(project, deps.canInstall, isolated)}`),
                    ...unknownDirs.map((dir) => {
                        const branch = mine.find((project) => project.dir === dir);
                        return branch === undefined
                            ? `Not installed: no project at \`${dir}\`. Call \`mcp__deps__status\` for the names.`
                            : branchOnlyLine(branch);
                    }),
                ]
                    .filter((text) => text !== "")
                    .join("\n"),
            );
        },
        { annotations: toolAnnotations("write") },
    );
};

// `install` is withheld from a persona that cannot change the workspace; `status` says why in its description.
export const depsTools = (deps: DepsToolDeps) => (deps.canInstall ? [statusTool(deps), installTool(deps)] : [statusTool(deps)]);

export const createDepsServer = (deps: DepsToolDeps): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({ name: "deps", tools: depsTools(deps) });
