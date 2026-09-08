import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../../runtimes/claude/claude-sdk.js";
import { z } from "zod";
import { unresolvedSummary } from "./dependency-drift.js";
import type { DependencyRequestOrigin } from "./dependency-origin.js";
import type { DependencyCoordinator } from "./reconcile-deps.js";
import { INSTALLABLE, missingCount, type ProjectSetupStatus } from "../layout/workspace-setup.js";

// Dependency readiness, asked for rather than pushed on every turn: the rule lives in these tool descriptions (paid
// once, cached), the state is fetched by whoever wants it. `install` requests rather than installs: a turn-side install
// would corrupt the shared tree, so the reconciler (reconcile-deps.ts) owns the one rule that makes it safe.

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

export interface DepsToolDeps {
    readonly dependencies: Pick<DependencyCoordinator, "status" | "requestInstall">;
    readonly canInstall: boolean;
    readonly origin: DependencyRequestOrigin;
}

// A project names itself by its directory; the root's manifest is "the workspace root", not empty string, matching the
// notices' own wording.
const where = (status: ProjectSetupStatus): string => (status.dir === "" ? "the workspace root" : status.dir);

// One project's readiness as a sentence the model can act on; `ready` is stated explicitly: half the value of asking is
// confirming a project is fine, so a failure there is the model's own.
const line = (status: ProjectSetupStatus, canInstall: boolean): string => {
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
            return `${where(status)}: installing right now. Its checks will be trustworthy once that finishes.`;
        case "stale":
            return (
                `${where(status)}, behind: ${missingCount(status)} declared dependencies are not installed ` +
                `(${unresolvedSummary(status.unresolved ?? [])}). Unresolved-import errors naming those are the install being ` +
                `behind, not a mistake in the code. Queued for repair; nothing to request.`
            );
        case "needs-setup":
            return canInstall
                ? `${where(status)}: never installed. Call \`mcp__deps__install\` for it, or say it is blocked; do not install it yourself.`
                : `${where(status)}, never installed. This persona cannot change the workspace, so ask the owner to install it.`;
        case "unsupported":
            return `${where(status)}: never installed, and \`${status.recipe.manager}\` is not in this sandbox. Nothing here can fix that; say so if it blocks the task.`;
    }
};

const standingRule = (canInstall: boolean): string =>
    `Never run a dependency install yourself from inside a turn: it writes to a scratch layer that is discarded when ` +
    `the conversation ends, and it rewrites the dependency tree other live conversations are reading. ${
        canInstall ? "Use `mcp__deps__install`." : "This persona cannot request one; ask the owner."
    }`;

export const createDepsServer = (deps: DepsToolDeps): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "deps",
        tools: [
            sdk().tool(
                "status",
                `Whether each project under /work actually has its declared dependencies installed. Call this when an import ` +
                    `will not resolve, a test fails on a missing module, or before you trust a type-check: it tells you whether ` +
                    `the failure is your code or an install that is behind. ${standingRule(deps.canInstall)}`,
                {},
                async () => {
                    const projects = await deps.dependencies.status();
                    if (projects.length === 0) {
                        return ok("No projects with a package manifest were found under /work.");
                    }
                    const behind = projects.filter((project) => project.state !== "ready" && project.state !== "installing");
                    const stale = projects.some((project) => project.state === "stale");
                    // The summary must reflect the weakest measurement: one project only checked for presence keeps "a
                    // failing import is your code" from being a claim nothing here verified.
                    const unwalked = projects.some((project) => project.state === "ready" && project.recipe.ecosystem !== "node");
                    return ok(
                        [
                            ...projects.map((project) => line(project, deps.canInstall)),
                            "",
                            behind.length === 0
                                ? unwalked
                                    ? "Everything has been installed at least once. Where that was all that was measured, an import that will not " +
                                      "resolve can still be the environment rather than the code."
                                    : "Everything is installed: a failing import here is a mistake in the code, not the tree."
                                : stale
                                  ? "Drifted projects are queued for repair between turns. First-time setup still needs the explicit action shown " +
                                    "above. Everything marked ready checks normally in the meantime."
                                  : "First-time setup needs the explicit action shown above. Everything marked ready checks normally in the meantime.",
                        ].join("\n"),
                    );
                },
            ),
            ...(deps.canInstall
                ? [
                      sdk().tool(
                          "install",
                          "Ask the daemon to install a project's dependencies. It does NOT run now: the install would corrupt the tree " +
                              "other live conversations are reading, so it is queued and runs once no conversation is mid-turn: meaning " +
                              "after this turn ends, and the tree is ready on a later turn, not this one. Only needed for a project that " +
                              "was never set up; drifted projects are already queued automatically.",
                          {
                              projects: z
                                  .array(z.string().max(500))
                                  .min(1)
                                  .max(50)
                                  .describe(
                                      "Project directories as `mcp__deps__status` names them, e.g. `intentic`. Use an empty string for the workspace root.",
                                  ),
                          },
                          async ({ projects }) => {
                              const result = await deps.dependencies.requestInstall(projects, deps.origin);
                              const known = result.projects;
                              const wanted = new Set(projects);
                              const matched = known.filter((project) => wanted.has(project.dir));
                              const unknown = projects.filter((dir) => !known.some((project) => project.dir === dir));
                              const queued = matched.filter((project) => result.queued.includes(project.dir));
                              return ok(
                                  [
                                      queued.length === 0
                                          ? "Nothing queued."
                                          : `Queued: ${queued.map(where).join(", ")}. The daemon starts the install once no conversation is mid-turn, ` +
                                            "after this turn ends. Do not run it yourself and do not wait for it; finish what else the task needs, say the " +
                                            "verification is deferred, and offer to re-run it next turn.",
                                      ...matched
                                          .filter((project) => !INSTALLABLE.has(project.state))
                                          .map((project) => `Not queued: ${line(project, deps.canInstall)}`),
                                      ...unknown.map((dir) => `Not queued: no project at \`${dir}\`. Call \`mcp__deps__status\` for the names.`),
                                  ]
                                      .filter((text) => text !== "")
                                      .join("\n"),
                              );
                          },
                      ),
                  ]
                : []),
        ],
    });
