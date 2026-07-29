import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

/* Steering the image boundary: a runtime install toward the owner-approved overlay, and — from the opposite
 * direction — a tool that turned out not to be there toward the same place.
 *
 * Anything installed outside /work dies with the container. The environment skill already explains how to
 * propose Dockerfile steps the owner approves, but an agent mid-task does not go and read a skill it has no
 * reason to suspect exists — it types `apt-get install` and moves on. One turn spent 250s and a 114 MiB
 * `npx playwright install chromium` rebuilding a browser the image now ships, and the layer it wrote is gone
 * on the next recreate. The moment the agent reaches for the install IS the moment it can be told, so this
 * rides in as PreToolUse context rather than as more standing prose in the system prompt.
 *
 * It STEERS, it does not block. A project-local `pnpm add`, a throwaway venv, a one-off experiment are all
 * legitimate and none of them want an image rebuild; only the agent knows which case it is in. Told once per
 * turn, for the same reason the missing-dependency notice is: the model needs the rule, not a nag. */

// Commands that install into the IMAGE's filesystem — the ones a container recreate silently undoes. Anything
// scoped to a project (`pnpm add`, `npm install` with no -g) is deliberately absent: node_modules lives under
// /work and survives, so steering those would be wrong.
const PERSISTENT_INSTALL = [
    /\bapt(-get)?\s+install\b/,
    /\bpip3?\s+install\b/,
    /\b(npm|pnpm|yarn)\s+(i|install|add)\s+(-g|--global)\b/,
    /\bplaywright\s+install\b/,
    /\brustup\b/,
    /\bnvm\s+install\b/,
];

// A venv is the sanctioned way to use pip here (Debian marks the system interpreter externally-managed), and
// it lands wherever the agent puts it — so a pip install INSIDE one is project scope, not image scope.
const VENV_SCOPED = /(\bsource\s+\S*\/activate\b|\bpython3?\s+-m\s+venv\b|\/venv\/bin\/pip\b|\.venv\/bin\/pip\b)/;

const BROWSER_ALREADY_BAKED =
    "This sandbox already ships Chromium and browser tools — load them with ToolSearch (`mcp__web__browser_navigate`, " +
    "`mcp__web__browser_take_screenshot`) instead of installing a browser. ";

// The overlay is the only place an image-scoped tool can outlive the container, so both notices below end by
// naming it — the same sentence, because they are the same instruction arrived at from opposite directions.
const OVERLAY_DRAFT =
    "write the install step to `.intentic/environment.d/<tool>.Dockerfile` (RUN/ENV lines only, no FROM) — the " +
    "daemon composes those drafts into one proposal for the owner to approve, and the `environment` skill has " +
    "the details.";

const GUIDANCE =
    "That install writes to the image filesystem, which a container recreate throws away — whatever you install " +
    "now is gone the next time this sandbox restarts, and the next session will hit the same missing tool. If you " +
    `need it only for this task, carry on. If it should persist, ALSO ${OVERLAY_DRAFT} Draft it now while ` +
    "you know why it is needed, then continue the task; drafting does not block you and does not need an answer.";

/* The other half of that boundary: the turn that never reaches for an install at all.
 *
 * A missing tool does not present itself as a decision — `command not found` scrolls past inside a tool result
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
// text — a grep over a log, a test asserting on an error string — and without this guard the notice fires on
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
// the SDK's own content array is the third shape. Read all three rather than bet on one.
const resultText = (response: unknown): string => {
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

export const installSteeringHooks = (): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
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
                        const missing = missingBinary(resultText(input.tool_response), command);
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
                        if (input.hook_event_name !== "PreToolUse" || told) {
                            return {};
                        }
                        // The tmux hook may already have rewrapped this command, so match on the whole string
                        // rather than its head — the inner command survives verbatim inside the wrapper.
                        const command = (input.tool_input as { command?: unknown }).command;
                        if (typeof command !== "string" || VENV_SCOPED.test(command) || !PERSISTENT_INSTALL.some((rule) => rule.test(command))) {
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
