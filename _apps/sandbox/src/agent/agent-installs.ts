import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

/* Steering a runtime install toward the owner-approved overlay.
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

const GUIDANCE =
    "That install writes to the image filesystem, which a container recreate throws away — whatever you install " +
    "now is gone the next time this sandbox restarts, and the next session will hit the same missing tool. If you " +
    "need it only for this task, carry on. If it should persist, ALSO write the install step to " +
    "`.intentic/environment.d/<tool>.Dockerfile` (RUN/ENV lines only, no FROM) — the daemon composes those drafts " +
    "into one proposal for the owner to approve, and the `environment` skill has the details. Draft it now while " +
    "you know why it is needed, then continue the task; drafting does not block you and does not need an answer.";

export const installSteeringHooks = (): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    let told = false;
    return {
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
