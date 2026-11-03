import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { HookCallback, PostToolUseHookInput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { z } from "zod";
import type { TurnTools } from "../../agent/providers/agent-request.js";
import { maskTargets } from "../../agent/tools/agent-redaction.js";
import { bashTmuxHooks } from "../../agent/tools/agent-terminals.js";
import type { BackgroundJobSeed } from "../../agent/tools/jobs/background-jobs.js";
import { handoffDirOf, type TurnPlacement } from "../../conversations/worktrees/isolation.js";
import { resolveCommandSecrets } from "../../secrets/secret-access.js";
import { createMaskWrapper } from "./mask-script.js";

/* ONE SHELL LINE, AS EVERY SHELL THE DAEMON JUDGES RUNS IT.

   The Claude Code loop's Bash hook (agent/tools/agent-terminals.ts bashTmuxHooks) is the one command runner: the line's
   secret references resolved, its absolute paths moved into the turn's worktree or its namespace hop added, the
   heavy-command table every program it starts is judged by, the turn's connector environment forwarded by name, the
   owner's output filter, and the conversation's tmux session in the terminal panel. A loop whose shell the daemon only
   judges (Codex's command, Pi's bash, an ACP agent's terminal/create) has its line rewritten here to the same thing, and,
   where the daemon does not read what the command prints before the model does, wrapped so every stored value in it is
   masked (mask-script.ts). 2026-10-25: Codex and Pi each kept their own copy of this, and an ACP terminal ran the
   agent's words bare: no secret reference resolved, nothing queued, no connector environment, nothing masked.

   A line in the panel that comes back still running (tmux-run's soft timeout, or a prompt) is filed as a background job
   the same way, by the hook's own PostToolUse half: `settle` hands it the call's result once the loop has it, and answers
   the note the agent must read (the job's id to `wait` on and `stop` by). 2026-11-02: the judged loops were built without
   the turn's job seed, so 116 such returns in 30 Codex conversations filed no job: the agent was told only where the
   output was, guessed wait targets, re-read the file and re-ran the command. */

export type ShellLineOutcome = { readonly command: string } | { readonly refuse: string };

// Where a line runs: the session whose tmux panel it lands in (the loop's own session id), and its directory.
export interface ShellLineAt {
    readonly session: string | undefined;
    readonly cwd: string;
    readonly id?: string | undefined;
}

export interface ShellLineOptions {
    readonly tools: Pick<TurnTools, "secrets" | "cliEnv" | "heavyCommands" | "offloadCommands">;
    readonly isolation: TurnPlacement | undefined;
    readonly owner: string | undefined;
    // Whether lines run through the terminal panel's tmux wrapper (agent-terminals.ts tmuxRunEnabled).
    readonly terminals: boolean;
    // Whether what the line prints is masked by the wrapper: a loop that reads every result through the daemon first
    // (Pi's extension) masks it there instead.
    readonly mask: boolean;
    // The first line that runs in the panel's session, for the loop's `terminal` frame.
    readonly onPanel?: (session: string) => void;
    // Where a line that comes back still running is filed as a job (AgentRequest.hooks.backgroundJobs); absent, it is
    // only said to be running, with nothing to wait on.
    readonly jobs?: BackgroundJobSeed | undefined;
}

export interface ShellLines {
    readonly line: (command: string, at: ShellLineAt, signal: AbortSignal) => Promise<ShellLineOutcome>;
    // Once a line's call returned, by the id it ran under (`at.id`) and the text it returned (ShellResultTextSchema): what
    // the agent must be told of it, where it came back still running and was filed as a job; undefined otherwise, and for
    // any call `line` never sent to the panel.
    readonly settle: (id: string, result: string, signal: AbortSignal) => Promise<string | undefined>;
    readonly dispose: () => Promise<void>;
}

const CommandInputSchema = z.object({ command: z.string() }).loose();

const SECRETS_UNREADABLE =
    "The sandbox's secrets could not be read, so this command's output could not be masked and it was not run. Retry once; if it fails again, say what you could not run.";

// The Claude loop's own Bash hooks, built once per runner so a call's PreToolUse and PostToolUse halves share what the
// first kept of it: the rewrite before the line runs, the job filing after it returned.
const panelHooks = (options: ShellLineOptions) => {
    const hooks = bashTmuxHooks(
        Object.keys(options.tools.cliEnv ?? {}),
        options.isolation,
        options.owner,
        options.tools.secrets,
        options.tools.heavyCommands,
        options.tools.offloadCommands,
        options.jobs,
    );
    return {
        pre: hooks.PreToolUse?.[0]?.hooks[0],
        post: hooks.PostToolUse?.find((matcher) => matcher.matcher === "Bash")?.hooks[0],
    };
};

// The panel's rewrite, asked of the hook as a Bash call in `at.session`: undefined where the line is not the wrapper's to
// take (no session, or already wrapped).
const panelRewrite = (hook: HookCallback | undefined) => {
    return async (command: string, at: ShellLineAt, signal: AbortSignal): Promise<ShellLineOutcome | undefined> => {
        if (hook === undefined || at.session === undefined) {
            return undefined;
        }
        const input: PreToolUseHookInput = {
            hook_event_name: "PreToolUse",
            session_id: at.session,
            transcript_path: "",
            cwd: at.cwd,
            tool_name: "Bash",
            tool_input: { command },
            tool_use_id: at.id ?? randomUUID(),
        };
        const answer = await hook(input, at.id, { signal });
        const output = "hookSpecificOutput" in answer ? answer.hookSpecificOutput : undefined;
        if (output?.hookEventName !== "PreToolUse") {
            return undefined;
        }
        if (output.permissionDecision === "deny") {
            return { refuse: output.permissionDecisionReason ?? "The terminal wrapper refused this command." };
        }
        const rewritten = CommandInputSchema.safeParse(output.updatedInput).data?.command;
        return rewritten === undefined ? undefined : { command: rewritten };
    };
};

// The panel's settle, asked of the hook's PostToolUse half: the note it adds for a call it filed as a job.
const panelSettle = (hook: HookCallback | undefined) => async (id: string, result: string, signal: AbortSignal): Promise<string | undefined> => {
    if (hook === undefined) {
        return undefined;
    }
    const input: PostToolUseHookInput = {
        hook_event_name: "PostToolUse",
        session_id: "",
        transcript_path: "",
        cwd: "",
        tool_name: "Bash",
        tool_input: {},
        tool_response: result,
        tool_use_id: id,
    };
    const answer = await hook(input, id, { signal });
    const output = "hookSpecificOutput" in answer ? answer.hookSpecificOutput : undefined;
    return output?.hookEventName === "PostToolUse" ? output.additionalContext : undefined;
};

/** One turn's command runner for a loop the daemon judges: the line in the panel's session or with its references
 *  resolved in place, then under the mask while there are stored values to mask. */
export const createShellLines = (options: ShellLineOptions): ShellLines => {
    const hooks = options.terminals ? panelHooks(options) : undefined;
    const panel = hooks === undefined ? undefined : panelRewrite(hooks.pre);
    const masks = createMaskWrapper(handoffDirOf(options.isolation?.anchor) ?? tmpdir());
    const secrets = options.tools.secrets;
    let surfaced = false;

    const surface = (at: ShellLineAt): void => {
        const session = at.session === undefined ? undefined : agentSessionName(at.session);
        if (!surfaced && session !== undefined) {
            surfaced = true;
            options.onPanel?.(session);
        }
    };

    const line = async (command: string, at: ShellLineAt, signal: AbortSignal): Promise<ShellLineOutcome> => {
        const wrapped = await panel?.(command, at, signal);
        if (wrapped !== undefined && "refuse" in wrapped) {
            return wrapped;
        }
        let executed = wrapped?.command;
        if (executed === undefined && secrets !== undefined) {
            const resolved = await resolveCommandSecrets(command, secrets);
            if ("refusal" in resolved) {
                return { refuse: resolved.refusal };
            }
            executed = resolved.command;
        }
        executed ??= command;
        if (wrapped !== undefined) {
            surface(at);
        }
        if (!options.mask || secrets === undefined) {
            return { command: executed };
        }
        let targets;
        try {
            targets = maskTargets(await secrets.list());
        } catch {
            return { refuse: SECRETS_UNREADABLE };
        }
        return { command: targets.length === 0 ? executed : await masks.wrap(executed, targets) };
    };

    return { line, settle: panelSettle(hooks?.post), dispose: () => masks.dispose() };
};
