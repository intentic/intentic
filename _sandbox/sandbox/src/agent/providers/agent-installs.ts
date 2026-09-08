import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { ClassifiedInstall } from "../../environment/runtime-installs.js";

// Anything installed outside /work dies with the container. Every image-scoped install is classified here and recorded
// silently to the runtime-install ledger; the drift sweep drafts the overlay step. A browser install is told the
// browser is already baked; a project dependency mutation is denied outright.

// A pip install inside a venv is project scope, not image scope.
const VENV_SCOPED = /(\bsource\s+\S*\/activate\b|\bpython3?\s+-m\s+venv\b|\/venv\/bin\/pip\b|\.venv\/bin\/pip\b)/;
const NODE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NODE_INSTALL_VERBS = new Set(["i", "install", "add", "ci", "update", "up", "upgrade", "remove", "rm", "uninstall", "prune", "dedupe"]);
// Verbs that add a package; a global uninstall must not enter the ledger.
const NODE_ADD_VERBS = new Set(["i", "install", "add"]);
const OPTION_WITH_VALUE = new Set(["--cwd", "--dir", "--filter", "--prefix", "-C"]);

// One quote-aware tokenizer, asked by every question below. Produces words per invocation, not joined strings, and the
// operator each segment ended on, so a quoted operator character cannot split the command.

// A heredoc body is a script, not a command; stripped line-wise, since that is how a heredoc is delimited. `<<<` is a
// here-string and stays an ordinary word.
const HEREDOC = /<<-?(?!<)\s*\\?(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/;

const withoutHeredocs = (command: string): string => {
    const kept: string[] = [];
    let delimiter: string | undefined;
    for (const line of command.split("\n")) {
        if (delimiter !== undefined) {
            if (line.trim() === delimiter) {
                delimiter = undefined;
            }
            continue;
        }
        kept.push(line);
        const opened = HEREDOC.exec(line);
        if (opened !== null) {
            delimiter = opened[1] ?? opened[2] ?? opened[3];
        }
    }
    return kept.join("\n");
};

// A redirection is not an argument. An operator with no target attached consumes the next word; one carrying its own
// target (`2>&1`, `>out.log`) takes only itself.
const REDIRECTION = /^(?:\d+|&)?(?:>>?|<<?)/;

const withoutRedirections = (words: readonly string[]): string[] => {
    const kept: string[] = [];
    for (let index = 0; index < words.length; index += 1) {
        const word = words[index] as string;
        if (!REDIRECTION.test(word)) {
            kept.push(word);
            continue;
        }
        if (word.replace(REDIRECTION, "") === "") {
            index += 1;
        }
    }
    return kept;
};

// Prefixes standing in front of the command that matters: env assignments, env/sudo/nice, a for/while body's loop
// keywords, and `timeout <n>`.
const PREFIX_WORDS = new Set(["env", "sudo", "nice", "then", "do"]);
const DURATION = /^[\d.]+[smhd]?$/;

const withoutPrefixes = (words: readonly string[]): string[] => {
    let start = 0;
    while (start < words.length) {
        const word = words[start] as string;
        if (PREFIX_WORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
            start += 1;
            continue;
        }
        if (word === "timeout") {
            let ahead = start + 1;
            while ((words[ahead] ?? "").startsWith("-")) {
                ahead += 1;
            }
            if (DURATION.test(words[ahead] ?? "")) {
                start = ahead + 1;
                continue;
            }
        }
        break;
    }
    return words.slice(start);
};

type Operator = "|" | "&&" | "||" | ";" | "&" | "\n";

interface CommandSegment {
    readonly words: readonly string[];
    /** The operator this segment ended on; absent at the command's end and around `(`…`)` grouping. */
    readonly next?: Operator;
}

const tokenize = (command: string): CommandSegment[] => {
    const segments: CommandSegment[] = [];
    let words: string[] = [];
    let word = "";
    let quote: "'" | '"' | undefined;
    let escaped = false;
    const endWord = (): void => {
        if (word !== "") {
            words.push(word);
            word = "";
        }
    };
    const endSegment = (next?: Operator): void => {
        endWord();
        const kept = withoutPrefixes(withoutRedirections(words));
        if (kept.length > 0) {
            segments.push(next === undefined ? { words: kept } : { words: kept, next });
        }
        words = [];
    };
    const source = withoutHeredocs(command);
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index] as string;
        if (escaped) {
            escaped = false;
            // A backslash-newline joins the two lines; it does not separate them.
            if (character !== "\n") {
                word += character;
            }
        } else if (character === "\\" && quote !== "'") {
            escaped = true;
        } else if (quote !== undefined) {
            if (character === quote) {
                quote = undefined;
            } else {
                word += character;
            }
        } else if (character === "'" || character === '"') {
            quote = character;
        } else if (character === "&" && /[<>]$/.test(word)) {
            // Mid-redirection: the `&` of `2>&1` binds to the operator before it, not to backgrounding.
            word += character;
        } else if (character === "|" || character === "&") {
            const doubled = source[index + 1] === character;
            endSegment((doubled ? `${character}${character}` : character) as Operator);
            index += doubled ? 1 : 0;
        } else if (character === ";" || character === "\n") {
            endSegment(character);
        } else if (character === "(" || character === ")") {
            endSegment();
        } else if (/\s/.test(character)) {
            endWord();
        } else {
            word += character;
        }
    }
    endSegment();
    return segments;
};

// The words of each invocation, quotes honoured; callers outside this file want words, not a joined string to re-split.
export const commandWords = (command: string): string[][] => tokenize(command).map((segment) => [...segment.words]);

// The same, joined, for tests here written as patterns over a whole invocation rather than as word arithmetic.
const commandInvocations = (command: string): string[] => tokenize(command).map((segment) => segment.words.join(" "));

const shellWords = (command: string): string[] => tokenize(command).flatMap((segment) => segment.words);

const executableOf = (words: readonly string[]): string | undefined => words[0]?.split("/").at(-1);

export const agentCommand = (command: string): string => {
    const words = shellWords(command);
    const wrapper = words.findIndex((word) => word.split("/").at(-1) === "tmux-run");
    if (wrapper === -1) {
        return command;
    }
    const carried = words.indexOf("-c", wrapper + 1);
    if (carried !== -1 && words[carried + 1] !== undefined) {
        return words[carried + 1] as string;
    }
    const session = words.findIndex((word, index) => index > wrapper && word.startsWith("agent-"));
    return session !== -1 && words[session + 1] !== undefined ? (words[session + 1] as string) : command;
};

const nodeInstall = (command: string): { project: boolean; global: boolean } => {
    for (const invocation of commandWords(command)) {
        const words = [...invocation];
        if (words[0] === "corepack") {
            words.shift();
        }
        const executable = words.shift()?.split("/").at(-1);
        if (executable === undefined || !NODE_MANAGERS.has(executable)) {
            continue;
        }
        const global = words.some((word) => word === "-g" || word === "--global");
        for (let index = 0; index < words.length; index += 1) {
            const word = words[index];
            if (word === undefined) {
                break;
            }
            if (OPTION_WITH_VALUE.has(word)) {
                index += 1;
                continue;
            }
            if (word.startsWith("-")) {
                continue;
            }
            return { project: NODE_INSTALL_VERBS.has(word) && !global, global: NODE_INSTALL_VERBS.has(word) && global };
        }
    }
    return { project: false, global: false };
};

// Classification: which tools an image-scoped install would put on this container.

// A shell a piped installer would be handed to, and the fetchers that hand it over.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const FETCHERS = new Set(["curl", "wget"]);
// Verbs of these that operate on a different container's filesystem than this one.
const CONTAINER_RUNNERS = new Set(["docker", "podman", "nerdctl"]);
const CONTAINER_VERBS = new Set(["run", "exec", "build", "buildx", "compose"]);

// Flags whose next word is a value, not a package; shared since the mistake looks the same everywhere.
const VALUE_FLAGS = new Set([
    ...OPTION_WITH_VALUE,
    "--version",
    "--vers",
    "--git",
    "--branch",
    "--tag",
    "--rev",
    "--root",
    "--features",
    "-F",
    "--registry",
    "--index",
    "--target",
    "-j",
    "--jobs",
    "--profile",
    "-t",
    "-o",
    "-r",
    "--python",
]);

// Bare package words after a verb; flags and value-flag values are skipped.
const packagesAfter = (words: readonly string[], start: number): string[] => {
    const packages: string[] = [];
    for (let index = start; index < words.length; index += 1) {
        const word = words[index];
        if (word === undefined) {
            break;
        }
        if (VALUE_FLAGS.has(word)) {
            index += 1;
            continue;
        }
        if (word.startsWith("-")) {
            continue;
        }
        packages.push(word);
    }
    return packages;
};

// What can be a package name at all, checked once on the finished name. A word that fails this is shell syntax or a
// path, not a package; digit-only names are rejected too.
const TOOL_NAME = /^@?[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)*$/;
const named = (tool: string): boolean => TOOL_NAME.test(tool) && /[A-Za-z]/.test(tool);

// `pkg@1.2` becomes pkg, `@scope/pkg@1.2` becomes @scope/pkg; a bare scope's own @ sits at position 0 and survives.
const withoutVersion = (name: string): string => {
    const at = name.lastIndexOf("@");
    return at > 0 ? name.slice(0, at) : name;
};

// `pillow==9.5` or `requests>=2` becomes the name pip resolves.
const withoutSpecifier = (name: string): string => name.split(/[=<>~!]/, 1)[0] ?? name;

// npx and `pnpm exec` are transparent wrappers; the tool being run sits after them.
const unwrapped = (words: string[]): string[] => {
    let current = words;
    for (;;) {
        const head = current[0]?.split("/").at(-1);
        if (head === "npx") {
            current = current.slice(1).filter((word, index) => !(index === 0 && word.startsWith("-")) && word !== "--yes" && word !== "-y");
            continue;
        }
        if ((head !== undefined && NODE_MANAGERS.has(head)) || head === "corepack") {
            const exec = current.indexOf("exec");
            if (exec !== -1) {
                current = current.slice(exec + 1);
                continue;
            }
        }
        return current;
    }
};

// Every tool an image-scoped install would put on the container, as (kind, tool) pairs the ledger merges on. Precision
// over recall: a miss costs one session's memory, a false entry costs the ledger its meaning.
export const classifyImageInstalls = (command: string): ClassifiedInstall[] => {
    const effective = agentCommand(command);
    const segments = tokenize(effective);
    // Checked on parsed segments, so a quoted `docker run` cannot silence a real install next to it.
    if (segments.some((segment) => CONTAINER_RUNNERS.has(executableOf(segment.words) ?? "") && CONTAINER_VERBS.has(segment.words[1] ?? ""))) {
        return [];
    }
    const venv = VENV_SCOPED.test(effective);
    const found: ClassifiedInstall[] = [];
    const add = (kind: ClassifiedInstall["kind"], tool: string): void => {
        if (named(tool) && !found.some((entry) => entry.kind === kind && entry.tool === tool)) {
            found.push({ kind, tool });
        }
    };

    // `curl | sh` read as adjacency between segments; a missed pipe is a pipe the shell never ran.
    for (const [index, segment] of segments.entries()) {
        const next = segments[index + 1];
        if (segment.next !== "|" || next === undefined) {
            continue;
        }
        if (!FETCHERS.has(executableOf(segment.words) ?? "") || !SHELLS.has(executableOf(next.words) ?? "")) {
            continue;
        }
        const url = /https?:\/\/([^/\s'"]+)/.exec(segment.words.join(" "));
        add("other", url?.[1] ?? "shell-installer");
    }

    for (const segment of segments) {
        const words = unwrapped([...segment.words]);
        const executable = executableOf(words);
        if (executable === undefined) {
            continue;
        }
        if (/^apt(?:-get)?$/.test(executable)) {
            const verb = words.indexOf("install");
            if (verb !== -1 && !words.some((word) => ["-s", "--simulate", "--dry-run", "--download-only", "--print-uris"].includes(word))) {
                for (const tool of packagesAfter(words, verb + 1)) {
                    add("apt", tool);
                }
            }
        } else if (/^pip3?$/.test(executable) && !venv) {
            if (words[1] === "install" && !words.includes("-r") && !words.includes("--requirement")) {
                for (const tool of packagesAfter(words, 2)) {
                    add("pip", withoutSpecifier(tool));
                }
            }
        } else if (executable === "playwright") {
            if (words[1] === "install") {
                const browsers = packagesAfter(words, 2);
                for (const tool of browsers.length > 0 ? browsers : ["chromium"]) {
                    add("playwright", tool);
                }
            }
        } else if (executable === "rustup") {
            if (words[1] === "target" && words[2] === "add") {
                for (const tool of packagesAfter(words, 3)) {
                    add("rustup-target", tool);
                }
            } else if ((words[1] === "component" && words[2] === "add") || (words[1] === "toolchain" && words[2] === "install")) {
                for (const tool of packagesAfter(words, 3)) {
                    add("other", `rustup-${words[1]}-${tool}`);
                }
            }
        } else if (executable === "cargo") {
            if (words[1] === "install") {
                for (const tool of packagesAfter(words, 2)) {
                    add("cargo", withoutVersion(tool));
                }
            }
        } else if (executable === "go") {
            if (words[1] === "install") {
                for (const tool of packagesAfter(words, 2).filter((word) => word.includes("@"))) {
                    add("go", withoutVersion(tool).split("/").at(-1) ?? tool);
                }
            }
        } else if (executable === "gem" || executable === "pipx") {
            if (words[1] === "install") {
                for (const tool of packagesAfter(words, 2)) {
                    add(executable, tool);
                }
            }
        } else if (executable === "dpkg") {
            // A local .deb is not necessarily in any repo; no apt step follows from it mechanically.
            if (words.includes("-i") || words.includes("--install")) {
                for (const tool of words.filter((word) => word.endsWith(".deb"))) {
                    add("other", tool.split("/").at(-1)?.split("_")[0] ?? tool);
                }
            }
        } else if (executable === "nvm") {
            if (words[1] === "install") {
                add("other", "nvm");
            }
        } else if (NODE_MANAGERS.has(executable) || executable === "corepack") {
            const bare = words[0] === "corepack" ? words.slice(1) : words;
            const global = bare.some((word) => word === "-g" || word === "--global");
            const verb = bare.findIndex((word, index) => index > 0 && NODE_ADD_VERBS.has(word));
            if (global && verb !== -1) {
                for (const tool of packagesAfter(bare, verb + 1)) {
                    add("npm", withoutVersion(tool));
                }
            }
        }
    }
    return found;
};

const projectInstallOf = (command: string): boolean => {
    const effective = agentCommand(command);
    const venv = VENV_SCOPED.test(effective);
    return (
        nodeInstall(effective).project ||
        (venv && commandInvocations(effective).some((part) => /^(?:\S*\/)?pip3?\s+(?:install|uninstall)\b/.test(part))) ||
        commandInvocations(effective).some((part) =>
            /^(?:uv\s+sync|poetry\s+(?:install|add|remove|update|sync)|pipenv\s+(?:install|uninstall|sync|update))\b/.test(part),
        )
    );
};

const BROWSER_ALREADY_BAKED =
    "This sandbox already ships Chromium and browser tools: load them with ToolSearch (`mcp__web__browser_navigate`, " +
    "`mcp__web__browser_take_screenshot`) instead of installing a browser.";

// A missing tool does not present itself as a decision; it scrolls past inside a tool result. The failure itself is the
// trigger, and the notice routes a project tool through its project, a system tool installed plainly.
// Ordered most specific first: zsh's message also matches the pattern below it, so it must run first.
const NOT_FOUND = [
    /command not found: ([\w.@+-]+)/, // zsh
    /(?:^|\s)([\w.@+-]+): command not found/, // bash, e.g. `bash: line 1: lsof: command not found`
    // dash/sh: `sh: 1: lsof: not found`. The line number is load-bearing: without it, an echoed "X: not found" string
    // reads as a real report too.
    /(?:^|\s)[\w.@+-]+: \d+: ([\w.@+-]+): not found/,
];

// Every name the shell's report could be about, in confidence order. A list, not one answer: the patterns overlap and
// only the caller knows which name it tried to run.
const notFoundBinaries = (output: string): string[] => {
    const names: string[] = [];
    for (const rule of NOT_FOUND) {
        const name = rule.exec(output)?.[1];
        if (name !== undefined && !names.includes(name)) {
            names.push(name);
        }
    }
    return names;
};

// The shell's report with no question asked about where the name came from. A check legitimately reaches its tools
// through a package script, where the command-position guard below would be wrong.
export const notFoundBinary = (output: string): string | undefined => notFoundBinaries(output)[0];

// The script a shell wrapper carries, or nothing when this invocation is not one; already unquoted off the tokenizer.
const nestedScript = (words: readonly string[]): string | undefined => {
    if (!SHELLS.has(executableOf(words) ?? "")) {
        return undefined;
    }
    const flag = words.indexOf("-c");
    return flag === -1 ? undefined : words[flag + 1];
};

// Every binary this command runs in command position, plus one level into `sh -c '…'`, since that wrapper carries the
// real command. Depth-capped rather than trusted to shrink.
const invokedBinaries = (command: string, depth = 0): Set<string> => {
    const names = new Set<string>();
    for (const words of commandWords(command)) {
        const executable = executableOf(words);
        if (executable === undefined || executable === "") {
            continue;
        }
        names.add(executable);
        const script = depth < 2 ? nestedScript(words) : undefined;
        for (const nested of script === undefined ? [] : invokedBinaries(script, depth + 1)) {
            names.add(nested);
        }
    }
    return names;
};

const MISSING_GUIDANCE =
    "is not on PATH in this sandbox. Do not silently route around it. If it belongs to a project, run it through " +
    "that project's package manager (`pnpm exec <tool>`, `npx <tool>`) or install the project's dependencies: " +
    "not globally. If it is a system tool, install it and carry on: the sandbox records runtime installs and " +
    "proposes durable image steps to the owner by itself.";

// The captured name must be something the command tried to run in command position, not merely quoted text a tool
// result echoes. Misses a tool reached through `xargs` or `find -exec`.
const missingBinary = (output: string, command: string): string | undefined => {
    const invoked = invokedBinaries(command);
    return notFoundBinaries(output).find((name) => invoked.has(name));
};

const SUBSTITUTION_GUIDANCE =
    "ran as a COMMAND SUBSTITUTION rather than as text. Backticks inside a double-quoted argument are not " +
    "literal: the shell executed that word and spliced its (empty) output into the command, so the pattern or " +
    "string you meant to pass silently lost it and the result you are reading answers a different question. " +
    "Single-quote the argument, or escape the backticks (\\`), and run it again.";

// Looks like a missing tool and is not: a backtick in a double-quoted argument runs as command substitution, so the
// search silently loses that term. Told apart by position: inside backticks, not command position.
const substitutedBacktick = (output: string, command: string): string | undefined => {
    const substituted = new Set<string>();
    for (const [, inner] of command.matchAll(/`([^`]*)`/g)) {
        const word = (inner ?? "").trim().split(/\s+/)[0];
        if (word !== undefined && word !== "") {
            substituted.add(word);
        }
    }
    return notFoundBinaries(output).find((name) => substituted.has(name));
};

// Bash results arrive as a plain string, a stdout/stderr record, or the SDK's content array; reads all three rather
// than betting on one. Exported so a second reader shares this instead of learning a fourth shape separately.
export const toolResultText = (response: unknown): string => {
    if (typeof response === "string") {
        return response;
    }
    if (response === null || typeof response !== "object") {
        return "";
    }
    const { stdout, stderr, content } = response as { stdout?: unknown; stderr?: unknown; content?: unknown };
    const parts = [stdout, stderr].filter((part) => typeof part === "string");
    if (Array.isArray(content)) {
        parts.push(...content.map((entry) => (entry as { text?: unknown }).text).filter((text) => typeof text === "string"));
    }
    return parts.join("\n");
};

export const installSteeringHooks = (
    canRequestProjectInstall = true,
    onImageInstall?: (installs: readonly ClassifiedInstall[], command: string) => void,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    let browserTold = false;
    let missingTold = false;
    // Its own latch: being told about a missing tool teaches nothing about quoting.
    let substitutionTold = false;
    return {
        PostToolUse: [
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse" || (missingTold && substitutionTold)) {
                            return {};
                        }
                        const command = (input.tool_input as { command?: unknown }).command;
                        if (typeof command !== "string") {
                            return {};
                        }
                        const output = toolResultText(input.tool_response);
                        // The more specific reading: an install answer here points away from the actual bug.
                        const substituted = substitutionTold ? undefined : substitutedBacktick(output, command);
                        if (substituted !== undefined) {
                            substitutionTold = true;
                            return {
                                hookSpecificOutput: {
                                    hookEventName: "PostToolUse",
                                    additionalContext: `\`${substituted}\` ${SUBSTITUTION_GUIDANCE}`,
                                },
                            };
                        }
                        const missing = missingTold ? undefined : missingBinary(output, command);
                        if (missing === undefined) {
                            return {};
                        }
                        missingTold = true;
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PostToolUse",
                                additionalContext: `\`${missing}\` ${MISSING_GUIDANCE}`,
                            },
                        };
                    },
                ],
            },
        ],
        PreToolUse: [
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PreToolUse") {
                            return {};
                        }
                        // Reads the original command from the tmux hook's `-c` field, not the rewrapped one.
                        const command = (input.tool_input as { command?: unknown }).command;
                        if (typeof command !== "string") {
                            return {};
                        }
                        if (projectInstallOf(command)) {
                            const route = canRequestProjectInstall
                                ? "Edit the manifest if the task needs a new dependency, then call `mcp__deps__install`; the daemon queues the real install for after this turn."
                                : "This persona cannot change the workspace; ask the owner to install it.";
                            return {
                                hookSpecificOutput: {
                                    hookEventName: "PreToolUse",
                                    permissionDecision: "deny",
                                    permissionDecisionReason: `A dependency install cannot run inside a turn: its scratch result is discarded and a shared-tree install would race other turns. ${route}`,
                                },
                            };
                        }
                        const installs = classifyImageInstalls(command);
                        if (installs.length === 0) {
                            return {};
                        }
                        // Silent: the ledger and drift sweep carry the durability question, not the model.
                        onImageInstall?.(installs, agentCommand(command));
                        const browser =
                            installs.some((install) => install.kind === "playwright") || /\bchromium\b|\bgoogle-chrome\b/.test(agentCommand(command));
                        if (!browser || browserTold) {
                            return {};
                        }
                        browserTold = true;
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PreToolUse",
                                additionalContext: BROWSER_ALREADY_BAKED,
                            },
                        };
                    },
                ],
            },
        ],
    };
};
