import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { unresolvedSummary } from "./dependency-drift.js";
import type { DependencyRequestOrigin } from "./dependency-origin.js";
import type { DependencyCoordinator } from "./reconcile-deps.js";
import { INSTALLABLE, missingCount, type ProjectSetupStatus } from "./workspace-setup.js";

/* THE DEPENDENCY TOOLS — readiness asked for, instead of announced.
 *
 * The same three facts used to ride the front of every user message: which projects are behind, that an
 * unresolved import there is the install rather than the code, and that a turn must not run the install itself.
 * Pushing them cost a paragraph per turn whether or not the turn ever went near a drifted project, and it was
 * re-pushed identically for as long as the drift lasted — which, before the reconciler learned to watch for the
 * manifest writes it was missing, could be days. Nothing about the paragraph was wrong; it was just addressed to
 * every turn rather than to the one that needed it.
 *
 * So the split is: the RULE lives in these descriptions, which are part of the cached tool prefix and are paid
 * for once per session, and the STATE is fetched by whoever wants it. What remains for the turn that never asks
 * is the post-edit and post-command notices, which speak only after something has actually failed.
 *
 * WHY `install` REQUESTS RATHER THAN INSTALLS. An install from inside a turn writes to a scratch layer that dies
 * with the conversation, and — worse — it rewrites the dependency tree every other live turn has mounted
 * beneath it, which the kernel does not define an answer for. That is a fact about where the turn stands, not
 * about who asked, so the tool cannot honour a request by running one: it hands the request to the reconciler,
 * which owns the one rule that makes an install safe (workspace/reconcile-deps.ts). The reply says so plainly,
 * because a tool that returned "installed" and meant "queued" would be the most expensive lie in the system. */

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

export interface DepsToolDeps {
    readonly dependencies: Pick<DependencyCoordinator, "status" | "requestInstall">;
    readonly canInstall: boolean;
    readonly origin: DependencyRequestOrigin;
}

// A project names itself by its directory; the root owns the manifest under a name rather than an empty string.
// The same wording the notices use, so an agent reading both is reading one vocabulary.
const where = (status: ProjectSetupStatus): string => (status.dir === "" ? "the workspace root" : status.dir);

// One project's readiness as a sentence the model can act on. `ready` is stated rather than omitted: half the
// value of asking is being told that the project you are about to test is fine, so a failure there is yours.
const line = (status: ProjectSetupStatus, canInstall: boolean): string => {
    switch (status.state) {
        case "ready":
            return `${where(status)} — ready. Its type-checks, linters and tests mean what they say.`;
        case "installing":
            return `${where(status)} — installing right now. Its checks will be trustworthy once that finishes.`;
        case "stale":
            return (
                `${where(status)} — behind: ${missingCount(status)} declared dependencies are not installed ` +
                `(${unresolvedSummary(status.unresolved ?? [])}). Unresolved-import errors naming those are the install being ` +
                `behind, not a mistake in the code. Queued for repair; nothing to request.`
            );
        case "needs-setup":
            return canInstall
                ? `${where(status)} — never installed. Call \`mcp__deps__install\` for it, or say it is blocked; do not install it yourself.`
                : `${where(status)} — never installed. This persona cannot change the workspace, so ask the owner to install it.`;
        case "unsupported":
            return `${where(status)} — never installed, and \`${status.recipe.manager}\` is not in this sandbox. Nothing here can fix that; say so if it blocks the task.`;
    }
};

const standingRule = (canInstall: boolean): string =>
    "Never run a dependency install yourself from inside a turn: it writes to a scratch layer that is discarded when " +
    "the conversation ends, and it rewrites the dependency tree other live conversations are reading. " +
    (canInstall ? "Use `mcp__deps__install`." : "This persona cannot request one; ask the owner.");

export const createDepsServer = (deps: DepsToolDeps): McpSdkServerConfigWithInstance =>
    createSdkMcpServer({
        name: "deps",
        tools: [
            tool(
                "status",
                "Whether each project under /work actually has its declared dependencies installed. Call this when an import " +
                    "will not resolve, a test fails on a missing module, or before you trust a type-check — it tells you whether " +
                    "the failure is your code or an install that is behind. " +
                    standingRule(deps.canInstall),
                {},
                async () => {
                    const projects = await deps.dependencies.status();
                    if (projects.length === 0) {
                        return ok("No projects with a package manifest were found under /work.");
                    }
                    const behind = projects.filter((project) => project.state !== "ready" && project.state !== "installing");
                    const stale = projects.some((project) => project.state === "stale");
                    return ok(
                        [
                            ...projects.map((project) => line(project, deps.canInstall)),
                            "",
                            behind.length === 0
                                ? "Everything is installed — a failing import here is a mistake in the code, not the tree."
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
                      tool(
                          "install",
                          "Ask the daemon to install a project's dependencies. It does NOT run now: the install would corrupt the tree " +
                              "other live conversations are reading, so it is queued and runs once no conversation is mid-turn — meaning " +
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
                                          : `Queued: ${queued.map(where).join(", ")}. The daemon starts the install once no conversation is mid-turn — ` +
                                            "after this turn ends. Do not run it yourself and do not wait for it; finish what else the task needs, say the " +
                                            "verification is deferred, and offer to re-run it next turn.",
                                      ...matched
                                          .filter((project) => !INSTALLABLE.has(project.state))
                                          .map((project) => `Not queued — ${line(project, deps.canInstall)}`),
                                      ...unknown.map((dir) => `Not queued — no project at \`${dir}\`. Call \`mcp__deps__status\` for the names.`),
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
