import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { posix } from "node:path";
import type { DependencyIssue } from "../workspace/reconcile-deps.js";
import { agentCommand, commandWords, toolResultText } from "./agent-installs.js";

/* THE DEPENDENCY NOTICE, SAID WHEN IT IS NEEDED AND NOT BEFORE.
 *
 * There is exactly one failure this whole area exists to prevent: an agent reads `Cannot find module 'vue'`,
 * concludes it got the import wrong, and edits working source to satisfy an error that was never about the
 * code. For a long time the defence against it was a paragraph stapled to the front of every user message for
 * as long as any project anywhere under /work was behind, true, unactionable for most of the turns that read
 * it, and re-read identically on every one of them.
 *
 * The moment the misreading becomes possible is the moment a command actually fails on a name. That is when
 * this speaks, and the difference is not only economy: a notice attached to the failure names THE package the
 * agent just tripped over, where the standing paragraph could only name a sample and leave the connection to be
 * guessed. The post-edit half of the same job lives in agent-diagnostics.ts; this is its command-line twin,
 * built the way agent-installs.ts builds the missing-binary steering, and for the same reason, the failure
 * itself is the only reliable trigger.
 *
 * IT VERIFIES BEFORE IT SPEAKS, which is the whole of its bug-resistance. A name lifted out of a failure is a
 * CLAIM, and the tree is the only thing that can settle it: unless the package is genuinely declared under
 * /work and genuinely not on disk, this says nothing at all. So a mistyped import stays the agent's own problem
 *, which matters more than the saving, because a notice that excused real mistakes would teach a model to
 * distrust every unresolved import it ever sees, and that is the same failure arrived at from the other side. */

// The shapes an unresolved package takes on the way out of a command. Node's two loaders word it differently,
// TypeScript's TS2307 reuses the CJS wording, and the bundlers have their own. Every one of them quotes the
// SPECIFIER, which is all this needs, the verification step decides whether it means anything.
const UNRESOLVED: readonly RegExp[] = [
    /Cannot find module ['"]([^'"\n]+)['"]/g,
    /Cannot find package ['"]([^'"\n]+)['"]/g,
    // Vite opens the sentence, Rollup embeds it mid-line ("Rollup failed to resolve import ..."), so the
    // leading word is matched either way rather than betting on which bundler printed it.
    /[Ff]ailed to resolve (?:import|entry for package) ["']([^"'\n]+)["']/g,
    /ERR_MODULE_NOT_FOUND[^\n]*?['"]([^'"\n]+)['"]/g,
];

// How many names one notice carries. The reader's decision, trust the error, or don't, is made by the second.
const NAMED = 3;
const DIRECT_CHECK_RUNNERS = new Set(["node", "tsc", "vite", "vitest", "jest", "mocha", "eslint", "biome", "turbo", "nx"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

const runsProjectCode = (command: string): boolean =>
    commandWords(agentCommand(command)).some((invocation) => {
        const words = [...invocation];
        const executable = words.shift()?.split("/").at(-1);
        if (executable === undefined) {
            return false;
        }
        if (DIRECT_CHECK_RUNNERS.has(executable)) {
            return true;
        }
        if (executable === "npx") {
            return words.length > 0;
        }
        if (!PACKAGE_MANAGERS.has(executable)) {
            return false;
        }
        const args = words.filter((word) => !word.startsWith("-"));
        return args.some((word) => /^(?:run|exec|dlx|test|type-?check|lint|build|check)$/.test(word));
    });

// Resolve the shell's explicit directory changes against the persona's starting project. We deliberately do
// not guess from an error path: a side-by-side project's filename in output is not evidence that the command
// ran there. `cd` is evidence, and covers the ordinary workspace-root turn (`cd app && pnpm test`) that a probe
// pinned only to the persona start folder would otherwise miss entirely.
export const dependencyDirForCommand = (start: string, workspaceRoot: string, command: string): string => {
    let current = start;
    const root = posix.normalize(workspaceRoot);
    const unwrapped = agentCommand(command);
    const changes = /(?:^|&&|\|\||;|\n)\s*cd\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
    for (const match of unwrapped.matchAll(changes)) {
        const next = match[1] ?? match[2] ?? match[3];
        if (next === undefined || next === "-") {
            continue;
        }
        const target = posix.normalize(next);
        const resolved = next.startsWith("/")
            ? target === root
                ? ""
                : target.startsWith(`${root}/`)
                  ? target.slice(root.length + 1)
                  : ".."
            : posix.normalize(posix.join(current, next));
        if (resolved !== ".." && !resolved.startsWith("../")) {
            current = resolved === "." ? "" : resolved;
        }
    }
    return current;
};

/* The PACKAGE a specifier belongs to: `@scope/pkg/sub` and `pkg/sub` both resolve through one installed
 * directory, and that directory is what a manifest declares and what the drift walk looks for.
 *
 * Relative paths, absolute paths and `node:` builtins are dropped rather than normalized. None of them can be a
 * declared dependency, so a name from one could only ever produce a wasted lookup, and an unresolved relative
 * import is precisely the mistake in the code this must never excuse. */
const packageOf = (specifier: string): string | undefined => {
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
        return undefined;
    }
    const parts = specifier.split("/");
    const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    return name === undefined || name === "" || (specifier.startsWith("@") && parts.length < 2) ? undefined : name;
};

const candidates = (output: string): string[] => {
    const names = new Set<string>();
    for (const rule of UNRESOLVED) {
        for (const match of output.matchAll(rule)) {
            const name = match[1] === undefined ? undefined : packageOf(match[1]);
            if (name !== undefined) {
                names.add(name);
            }
        }
    }
    return [...names];
};

const notice = (issue: DependencyIssue, names: readonly string[], canInstall: boolean): string => {
    const shown = names
        .slice(0, NAMED)
        .map((name) => `\`${name}\``)
        .join(", ");
    const one = names.length === 1;
    return (
        `${shown}${names.length > NAMED ? ` and ${names.length - NAMED} more` : ""} ${one ? "is" : "are"} declared under /work ` +
        `and not installed, so that failure is the install being behind rather than a mistake in the code. Do not edit working ` +
        `source to satisfy it, and do not run an install yourself: from inside a turn it writes to a scratch layer that is ` +
        `discarded when the conversation ends, and it rewrites the dependency tree other live conversations are reading. The ${
            issue.state === "stale"
                ? `daemon has queued its repair, so this project's own checks are available on a later turn, not this one. `
                : canInstall
                  ? `this project has never been set up; call \`mcp__deps__install\` to queue it for after the turn. `
                  : `this project has never been set up and this persona cannot change it; ask the owner to install it. `
        }Everything ` +
        `already installed checks normally in the meantime: call \`mcp__deps__status\` for which projects those are. Finish ` +
        `the rest of the task, say this verification is deferred, and offer to re-run it next turn.`
    );
};

/* PostToolUse on Bash: a command that failed on a package the tree really is missing earns one sentence.
 *
 * Created once per turn (baseOptions), which is what the memories below are scoped to. Answers are keyed by the
 * effective command as well as package name: a root-level `pnpm test` and `cd app && pnpm test` can belong to
 * different projects, so caching one workspace-wide answer would recreate the cross-project false positive
 * this hook exists to avoid. `told` is per project/package: the model needs the reason, not a nag.
 *
 * A name is looked up ONCE and never revisited, and that is a deliberate limit rather than an oversight. No
 * install runs while a turn is live, that is the rule this notice is built around, so the answer cannot
 * change underneath it. The one thing it will miss is a dependency the agent itself added to a manifest this
 * turn, whose failure then arrives without the sentence explaining it; the errors are still right, and only the
 * reason goes unsaid. */
export const depsNoticeHooks = (
    issue: (command: string) => Promise<DependencyIssue | undefined>,
    canInstall: boolean,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const checked = new Map<string, boolean>();
    const told = new Set<string>();
    const issues = new Map<string, DependencyIssue | undefined>();
    return {
        PostToolUse: [
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse") {
                            return {};
                        }
                        const command = (input.tool_input as { command?: unknown }).command;
                        if (typeof command !== "string" || !runsProjectCode(command)) {
                            return {};
                        }
                        const names = candidates(toolResultText(input.tool_response));
                        if (names.length === 0) {
                            return {};
                        }
                        const commandKey = agentCommand(command);
                        const keyOf = (name: string): string => `${commandKey}\0${name}`;
                        let projectIssue = issues.get(commandKey);
                        if (names.some((name) => !checked.has(keyOf(name)))) {
                            // One walk answers for every name in this failure. A walk that cannot be taken
                            // leaves the verdicts unrecorded rather than guessed, silence is the safe answer,
                            // and the next failure may find the tree readable.
                            if (!issues.has(commandKey)) {
                                try {
                                    projectIssue = await issue(command);
                                    issues.set(commandKey, projectIssue);
                                } catch {
                                    return {};
                                }
                            }
                            if (projectIssue === undefined) {
                                return {};
                            }
                            for (const name of names) {
                                checked.set(keyOf(name), projectIssue.names.includes(name));
                            }
                        }
                        if (projectIssue === undefined) {
                            return {};
                        }
                        const fresh = names.filter((name) => checked.get(keyOf(name)) === true && !told.has(`${projectIssue.dir}\0${name}`));
                        if (fresh.length === 0) {
                            return {};
                        }
                        for (const name of fresh) {
                            told.add(`${projectIssue.dir}\0${name}`);
                        }
                        return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notice(projectIssue, fresh, canInstall) } };
                    },
                ],
            },
        ],
    };
};
