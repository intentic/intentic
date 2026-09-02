import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { ClassifiedInstall } from "../environment/runtime-installs.js";

/* The image boundary, held by the HARNESS rather than by prose.
 *
 * Anything installed outside /work dies with the container. This hook used to answer that with a paragraph —
 * "if it should persist, ALSO draft an overlay step" — and the transcript record is the measurement of how that
 * went: cargo-xwin reinstalled in six sessions, a Windows rustup target in eight, not one draft written. So the
 * model is no longer asked to do the bookkeeping. Every image-scoped install is CLASSIFIED here and recorded
 * silently to the runtime-install ledger (environment/runtime-installs.ts); the drift sweep joins that record
 * with what the container actually has and drafts the overlay step itself (environment/auto-drafts.ts). The
 * model installs and moves on, which is exactly what it was doing anyway.
 *
 * What still speaks to the model is only what changes its behaviour IN THE MOMENT: a browser install is told
 * the browser is already baked (a 250s / 114 MiB detour otherwise), and a project dependency mutation is denied
 * outright — an isolated turn's install is discarded and a shared-tree install races every other mounted turn,
 * so that one is not advice. */

// A venv is the sanctioned way to use pip here (Debian marks the system interpreter externally-managed), and
// it lands wherever the agent puts it, so a pip install INSIDE one is project scope, not image scope.
const VENV_SCOPED = /(\bsource\s+\S*\/activate\b|\bpython3?\s+-m\s+venv\b|\/venv\/bin\/pip\b|\.venv\/bin\/pip\b)/;
const NODE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NODE_INSTALL_VERBS = new Set(["i", "install", "add", "ci", "update", "up", "upgrade", "remove", "rm", "uninstall", "prune", "dedupe"]);
// Verbs that ADD a package; a global uninstall is not an install and must not enter the ledger.
const NODE_ADD_VERBS = new Set(["i", "install", "add"]);
const OPTION_WITH_VALUE = new Set(["--cwd", "--dir", "--filter", "--prefix", "-C"]);

const shellWords = (command: string): string[] => {
    const words: string[] = [];
    let word = "";
    let quote: "'" | '"' | undefined;
    let escaped = false;
    for (const character of command) {
        if (escaped) {
            word += character;
            escaped = false;
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
        } else if (/\s/.test(character)) {
            if (word !== "") {
                words.push(word);
                word = "";
            }
        } else {
            word += character;
        }
    }
    if (word !== "") {
        words.push(word);
    }
    return words;
};

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

// Read command INVOCATIONS, not arbitrary substrings. The previous unanchored expressions denied harmless
// commands such as `rg 'pnpm install' docs` merely because the words appeared in a quoted search. Splitting at
// shell control operators is deliberately modest rather than pretending to be a shell parser; each candidate
// still has to begin with the package manager after ordinary prefixes — env assignments, env/sudo/nice, and
// `timeout <n>`, which transcript mining showed wrapped around half the slow installs (`timeout 600 npx
// playwright install chromium`).
export const commandInvocations = (command: string): string[] =>
    command
        .split(/(?:&&|\|\||[;|\n])/)
        .map((part) => part.trim().replace(/^(?:(?:then|do)\s+)?(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+|env|sudo|nice|timeout\s+[\d.]+[smhd]?)\s+)*/, ""))
        .filter((part) => part !== "");

const nodeInstall = (command: string): { project: boolean; global: boolean } => {
    for (const invocation of commandInvocations(command)) {
        const words = invocation.split(/\s+/);
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

/* ---- classification: which tools an image-scoped install would put on this container ---- */

// Flags whose NEXT word is a value, not a package. Shared across ecosystems because misreading `--version 1.2`
// as a package named "1.2" pollutes the ledger the same way everywhere; a flag listed here that some tool does
// not take merely skips a word that was not a package either.
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

// Bare package words after a verb: flags skipped, value-flag values skipped, surrounding quotes shed.
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
        packages.push(word.replace(/^['"]|['"]$/g, ""));
    }
    return packages;
};

// `pkg@1.2` → pkg, `@scope/pkg@1.2` → @scope/pkg; a bare scope's own @ is position 0 and survives.
const withoutVersion = (name: string): string => {
    const at = name.lastIndexOf("@");
    return at > 0 ? name.slice(0, at) : name;
};

// `pillow==9.5` / `requests>=2` → the name pip resolves.
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

/* Every tool an image-scoped install in this command would put on the container, as (kind, tool) pairs the
 * ledger merges on. Precision over recall at the edges — `rustup target list` is not an install, `apt-get
 * install --dry-run` is not an install, and anything inside `docker run` mutates a DIFFERENT container — the
 * drift sweep corroborates against the live filesystem anyway, so a miss here costs one session of memory
 * while a false entry costs the ledger its meaning. */
export const classifyImageInstalls = (command: string): ClassifiedInstall[] => {
    const effective = agentCommand(command);
    // Installs inside another container's filesystem are that container's business; skipping the whole command
    // over one docker word can only lose entries the corroboration gate would have discarded later.
    if (/\b(?:docker|podman|nerdctl)\s+(?:run|exec|build|buildx|compose)\b/.test(effective)) {
        return [];
    }
    const venv = VENV_SCOPED.test(effective);
    const found: ClassifiedInstall[] = [];
    const add = (kind: ClassifiedInstall["kind"], tool: string): void => {
        if (tool !== "" && !found.some((entry) => entry.kind === kind && entry.tool === tool)) {
            found.push({ kind, tool });
        }
    };

    // The pipe is a separator commandInvocations splits on, so installer pipes are read off the whole command.
    const piped = /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/.exec(effective);
    if (piped !== null) {
        const url = /https?:\/\/([^/\s'"]+)/.exec(piped[0]);
        add("other", url?.[1] ?? "shell installer");
    }

    for (const invocation of commandInvocations(effective)) {
        const words = unwrapped(invocation.split(/\s+/).filter((word) => word !== ""));
        const executable = words[0]?.split("/").at(-1);
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
            // A local .deb is not necessarily in any repo, so no apt step follows from it mechanically.
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

/* The other half of that boundary: the turn that never reaches for an install at all.
 *
 * A missing tool does not present itself as a decision, `command not found` scrolls past inside a tool result
 * and the model quietly picks a worse route. Mining this workspace's transcripts found `file` reached for in
 * eight separate sessions and installed in none of them; the image now ships it and thirty-odd other staples,
 * but the tail is endless and the next one is unknowable. So the failure itself is the trigger, and the notice
 * routes: a project tool through its project, a system tool installed plainly — the ledger and the drift sweep
 * do the durability bookkeeping, so the model is told it need not. */
/* Ordered most-specific first, and that ordering is not cosmetic: zsh says `zsh: command not found: lsof`,
 * which the bash pattern below reads as "`zsh` was not found". Whichever runs first wins, so the shape that can
 * only mean one thing goes first. */
const NOT_FOUND = [
    /command not found: ([\w.@+-]+)/, // zsh
    /(?:^|\s)([\w.@+-]+): command not found/, // bash: `bash: line 1: lsof: command not found`
    /* dash/sh: `sh: 1: lsof: not found`. THE LINE NUMBER IS LOAD-BEARING and was not always required. Without
     * it the pattern reads "<word>: not found" anywhere, which is a sentence people write: a turn probing this
     * very question ran `sh -c 'command -v oxlint || echo "sh: not found"'` and was told that `sh` — the shell
     * that had just run, sitting at /usr/bin/sh — was missing. Dash always reports through the shell name and
     * the script line, so the shape it actually emits is the shape to match. */
    /(?:^|\s)[\w.@+-]+: \d+: ([\w.@+-]+): not found/,
];

/* Every name the shell's report could be about, in confidence order. A LIST rather than one answer because the
 * patterns overlap on real output and the caller is the one holding the tie-breaker: `zsh: command not found:
 * lsof` yields `lsof` then `zsh`, and only the command knows which of those it tried to run. */
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

// The shell's report with no question asked about where the name came from. Exported for the turn-ending gate,
// which asks this of a CHECK's output: a check legitimately reaches its tools through a package script
// (`pnpm lint` → `oxlint`), so the command-position guard below would be wrong there and the raw probe is right.
export const notFoundBinary = (output: string): string | undefined => notFoundBinaries(output)[0];

/* Every binary this command runs IN COMMAND POSITION, which is the only place a missing one can be missing
 * from. One level into `sh -c '…'` as well, because that wrapper is how the tmux runner and `timeout` carry a
 * real command and the tool that is actually absent is inside it. Depth-capped: the recursion only ever shrinks
 * the string, but a cap is cheaper than trusting that. */
const executableOf = (invocation: string): string | undefined => {
    const word = invocation.split(/\s+/)[0]?.split("/").at(-1);
    return word === undefined || word === "" ? undefined : word;
};

// The script a shell wrapper carries, or nothing when this invocation is not one.
const nestedScript = (invocation: string, executable: string): string | undefined =>
    /^(?:ba|da|z|k)?sh$/.test(executable) ? /-c\s+(['"])([\s\S]*?)\1/.exec(invocation)?.[2] : undefined;

const invokedBinaries = (command: string, depth = 0): Set<string> => {
    const names = new Set<string>();
    for (const invocation of commandInvocations(command)) {
        const executable = executableOf(invocation);
        if (executable === undefined) {
            continue;
        }
        names.add(executable);
        const script = depth < 2 ? nestedScript(invocation, executable) : undefined;
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

/* The captured name must be something the command actually TRIED TO RUN. A tool result is full of other
 * people's text — a grep over a log, a test asserting on an error string — and the notice has to survive that.
 *
 * This guard used to ask only whether the name appeared ANYWHERE in the command, and a word in a quoted
 * argument satisfies that as easily as a real invocation: a turn searching for the string `ask` in its own test
 * file was told to install `ask`. Command position is the question that was meant all along, and
 * commandInvocations already parses it for the install classifier above. What it gives up is a tool reached
 * through something this cannot see (`xargs foo`, `find -exec`), the same trade the loose version documented
 * and did not actually make. */
const missingBinary = (output: string, command: string): string | undefined => {
    const invoked = invokedBinaries(command);
    return notFoundBinaries(output).find((name) => invoked.has(name));
};

const SUBSTITUTION_GUIDANCE =
    "ran as a COMMAND SUBSTITUTION rather than as text. Backticks inside a double-quoted argument are not " +
    "literal: the shell executed that word and spliced its (empty) output into the command, so the pattern or " +
    "string you meant to pass silently lost it and the result you are reading answers a different question. " +
    "Single-quote the argument, or escape the backticks (\\`), and run it again.";

/* THE MISTAKE THAT LOOKS LIKE A MISSING TOOL AND IS NOT. `rg -n "kind: \`ask\`|decision" file` reads as one
 * regex and runs as two things: bash substitutes `ask`, reports `command not found`, and rg searches for a
 * pattern with that alternative missing — silently, with a clean exit and plausible hits. It is the most common
 * quoting error in this workspace's transcripts and the old notice answered it with "install `ask`", which is
 * advice pointing exactly away from the bug.
 *
 * Told apart from a genuinely missing tool by where the name sits: inside a backtick pair, not in command
 * position. Asked FIRST for that reason — it is the more specific reading of the same shell message. */
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

// Bash results arrive as a plain string from some harness versions and as a stdout/stderr record from others;
// the SDK's own content array is the third shape. Read all three rather than bet on one. Exported because the
// dependency notice reads the same results looking for a different failure (agent-deps.ts), and two copies of
// this would be two chances to learn about a fourth shape separately.
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
    // Its own latch, because it is its own lesson: a turn that has been told about a missing tool has not been
    // told anything about its quoting, and the two mistakes are made by different commands.
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
                        // The specific reading of the shell's message first: a substituted backtick IS a
                        // `command not found`, and answering it with an install is advice pointing away.
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
                        // The tmux hook may already have rewrapped this command; classification reads the
                        // original command carried in its `-c` field before reading actual invocations.
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
                        // The record is the whole point and it is SILENT: the ledger and the drift sweep carry
                        // the durability question to the owner, so the model is not asked to.
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
