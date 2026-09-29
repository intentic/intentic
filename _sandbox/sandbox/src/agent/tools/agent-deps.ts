import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { posix } from "node:path";
import type { DependencyIssue } from "../../workspace/deps/reconcile-deps.js";
import { agentCommand, commandWords, toolResultText } from "../providers/agent-installs.js";

// Speaks only when a command actually fails on a package name, naming that package rather than a standing paragraph
// read on every turn. Verifies against the tree first: unless the package is genuinely declared and genuinely missing,
// it says nothing, so a real import mistake stays the agent's problem.

// Every loader/bundler's wording for an unresolved import quotes the specifier; that's all this extracts.
const UNRESOLVED: readonly RegExp[] = [
    /Cannot find module ['"]([^'"\n]+)['"]/g,
    /Cannot find package ['"]([^'"\n]+)['"]/g,
    // Vite opens the sentence, Rollup embeds it mid-line, so the leading word is matched either way.
    /[Ff]ailed to resolve (?:import|entry for package) ["']([^"'\n]+)["']/g,
    /ERR_MODULE_NOT_FOUND[^\n]*?['"]([^'"\n]+)['"]/g,
];

// How many names one notice carries; trusting the error from there is the reader's call.
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

// Only explicit `cd` in the command counts, never a filename guessed from the error output: a side-by-side project's
// name there is not evidence the command ran there.
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

// `@scope/pkg/sub` and `pkg/sub` both resolve to one installed directory. Relative paths, absolute paths and `node:`
// builtins are dropped: none can be a declared dependency, and excusing one would hide a real code mistake.
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
        `source to satisfy it. ${
            issue.state === "stale"
                ? `The daemon is already repairing this project in the main tree; \`mcp__deps__install\` waits until it is done, and ` +
                  `its checks mean what they say after that. `
                : canInstall
                  ? `This project has never been set up: run its install yourself (a conversation in its own worktree installs ` +
                    `into its own copy of the tree), or call \`mcp__deps__install\` to have the daemon install it in the main tree and wait. `
                  : `This project has never been set up and this persona cannot change it; ask the owner to install it. `
        }Everything ` +
        `already installed checks normally in the meantime: call \`mcp__deps__status\` for which projects those are.`
    );
};

// Keyed by command as well as package, so a root `pnpm test` and one behind `cd app` aren't conflated. Looked up once
// per name and never revisited: an install the turn runs after being told fixes the failure it was told about, and a
// second telling would only repeat it (it can miss a dependency the turn itself just added).
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
                            // One walk answers every name here; a failed walk leaves verdicts unrecorded rather than
                            // guessed.
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
