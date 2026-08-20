import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { stateRelPath } from "../workspace/state-paths.js";

/* Steering the image boundary: a runtime install toward the owner-approved overlay, and, from the opposite
 * direction, a tool that turned out not to be there toward the same place.
 *
 * Anything installed outside /work dies with the container. The environment skill already explains how to
 * propose Dockerfile steps the owner approves, but an agent mid-task does not go and read a skill it has no
 * reason to suspect exists, it types `apt-get install` and moves on. One turn spent 250s and a 114 MiB
 * `npx playwright install chromium` rebuilding a browser the image now ships, and the layer it wrote is gone
 * on the next recreate. The moment the agent reaches for the install IS the moment it can be told, so this
 * rides in as PreToolUse context rather than as more standing prose in the system prompt.
 *
 * Image-scoped installs are steered, because a one-off experiment can be legitimate even though it will not
 * survive a recreate. Project dependency mutations are different: they are denied inside a turn and handed to
 * the workspace coordinator, because an isolated result is discarded and a shared-tree result races every
 * other mounted turn. */

// A venv is the sanctioned way to use pip here (Debian marks the system interpreter externally-managed), and
// it lands wherever the agent puts it, so a pip install INSIDE one is project scope, not image scope.
const VENV_SCOPED = /(\bsource\s+\S*\/activate\b|\bpython3?\s+-m\s+venv\b|\/venv\/bin\/pip\b|\.venv\/bin\/pip\b)/;
const NODE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NODE_INSTALL_VERBS = new Set(["i", "install", "add", "ci", "update", "up", "upgrade", "remove", "rm", "uninstall", "prune", "dedupe"]);
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
// still has to begin with the package manager after ordinary env/sudo prefixes.
export const commandInvocations = (command: string): string[] =>
    command
        .split(/(?:&&|\|\||[;|\n])/)
        .map((part) => part.trim().replace(/^(?:(?:then|do)\s+)?(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+|env|sudo)\s+)*/, ""))
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

const installScope = (command: string): { image: boolean; project: boolean } => {
    const effective = agentCommand(command);
    const node = nodeInstall(effective);
    const venv = VENV_SCOPED.test(effective);
    const image =
        node.global ||
        commandInvocations(effective).some(
            (part) =>
                /^apt(?:-get)?\s+install\b/.test(part) ||
                (!venv && /^pip3?\s+install\b/.test(part)) ||
                /^(?:npx\s+)?playwright\s+install\b/.test(part) ||
                /^rustup\b/.test(part) ||
                /^nvm\s+install\b/.test(part),
        );
    const project =
        node.project ||
        (venv && commandInvocations(effective).some((part) => /^(?:\S*\/)?pip3?\s+(?:install|uninstall)\b/.test(part))) ||
        commandInvocations(effective).some((part) =>
            /^(?:uv\s+sync|poetry\s+(?:install|add|remove|update|sync)|pipenv\s+(?:install|uninstall|sync|update))\b/.test(part),
        );
    return { image, project };
};

const BROWSER_ALREADY_BAKED =
    "This sandbox already ships Chromium and browser tools — load them with ToolSearch (`mcp__web__browser_navigate`, " +
    "`mcp__web__browser_take_screenshot`) instead of installing a browser. ";

// The overlay is the only place an image-scoped tool can outlive the container, so both notices below end by
// naming it, the same sentence, because they are the same instruction arrived at from opposite directions.
const OVERLAY_DRAFT =
    // Interpolated for real: as a plain string this notice told the agent to write under a literal
    // dollar-brace STATE_DIR spelling, template syntax and all.
    `write the install step to \`${stateRelPath(".intentic/config/environment.d/")}/<tool>.Dockerfile\` (RUN/ENV lines only, no FROM) — the ` +
    "daemon composes those drafts into one proposal for the owner to approve, and the `environment` skill has " +
    "the details.";

const GUIDANCE =
    "That install writes to the image filesystem, which a container recreate throws away — whatever you install " +
    "now is gone the next time this sandbox restarts, and the next session will hit the same missing tool. If you " +
    `need it only for this task, carry on. If it should persist, ALSO ${OVERLAY_DRAFT} Draft it now while ` +
    "you know why it is needed, then continue the task; drafting does not block you and does not need an answer.";

/* The other half of that boundary: the turn that never reaches for an install at all.
 *
 * A missing tool does not present itself as a decision, `command not found` scrolls past inside a tool result
 * and the model quietly picks a worse route, so the rule above never gets the chance to fire. Mining this
 * workspace's transcripts found `file` reached for in eight separate sessions and installed in none of them;
 * the image now ships it and thirty-odd other staples, but the tail is endless and the next one is unknowable.
 * So the failure itself is the trigger, and the notice names the only two places an answer can live: the
 * project (where a dependency belongs) or the image (where a system tool belongs). */
const NOT_FOUND = [
    /(?:^|\s)([\w.@+-]+): command not found/, // bash: `bash: line 1: lsof: command not found`
    /command not found: ([\w.@+-]+)/, // zsh
    /(?:^|\s)([\w.@+-]+): not found/, // dash/sh: `sh: 1: lsof: not found`
];

const MISSING_GUIDANCE =
    "is not on PATH in this sandbox. Do not silently route around it. If it belongs to a project, run it through " +
    "that project's package manager (`pnpm exec <tool>`, `npx <tool>`) or install the project's dependencies — " +
    "not globally. If it is a system tool this image should have shipped, install it for this task if you need it " +
    `now, and ALSO ${OVERLAY_DRAFT}`;

// The captured name must also appear in the command that produced it. A tool result is full of other people's
// text, a grep over a log, a test asserting on an error string, and without this guard the notice fires on
// output that merely QUOTES a shell failure. Anything genuinely missing was named in the command by definition
// (the tmux wrapper keeps the inner command verbatim), so the guard costs no true positives; a tool missing
// from inside a script the command merely invoked is given up deliberately, in exchange for never crying wolf.
const missingBinary = (output: string, command: string): string | undefined => {
    for (const rule of NOT_FOUND) {
        const name = rule.exec(output)?.[1];
        if (name !== undefined && new RegExp(`(?:^|[^\\w.@+-])${name.replace(/[.+]/g, "\\$&")}(?:[^\\w.@+-]|$)`).test(command)) {
            return name;
        }
    }
    return undefined;
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

export const installSteeringHooks = (canRequestProjectInstall = true): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    let told = false;
    let missingTold = false;
    return {
        PostToolUse: [
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse" || missingTold) {
                            return {};
                        }
                        const command = (input.tool_input as { command?: unknown }).command;
                        if (typeof command !== "string") {
                            return {};
                        }
                        const missing = missingBinary(toolResultText(input.tool_response), command);
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
                        // The tmux hook may already have rewrapped this command; installScope reads the original
                        // command carried in its `-c` field before classifying actual invocations.
                        const command = (input.tool_input as { command?: unknown }).command;
                        if (typeof command !== "string") {
                            return {};
                        }
                        const { image: imageInstall, project: projectInstall } = installScope(command);
                        if (projectInstall) {
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
                        if (told || !imageInstall) {
                            return {};
                        }
                        told = true;
                        const browser = /\bplaywright\s+install\b|\bchromium\b|\bgoogle-chrome\b/.test(command) ? BROWSER_ALREADY_BAKED : "";
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PreToolUse",
                                additionalContext: `${browser}${GUIDANCE}`,
                            },
                        };
                    },
                ],
            },
        ],
    };
};
