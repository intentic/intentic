import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { z } from "zod";
import type { TurnTools } from "../../agent/providers/agent-request.js";
import { maskTargets } from "../../agent/tools/agent-redaction.js";
import { bashTmuxHooks } from "../../agent/tools/agent-terminals.js";
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
   agent's words bare: no secret reference resolved, nothing queued, no connector environment, nothing masked. */

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
}

export interface ShellLines {
    readonly line: (command: string, at: ShellLineAt, signal: AbortSignal) => Promise<ShellLineOutcome>;
    readonly dispose: () => Promise<void>;
}

const CommandInputSchema = z.object({ command: z.string() }).loose();

const SECRETS_UNREADABLE =
    "The sandbox's secrets could not be read, so this command's output could not be masked and it was not run. Retry once; if it fails again, say what you could not run.";

// The panel's rewrite, asked of the Claude loop's own hook as a Bash call in `at.session`: undefined where the line is
// not the wrapper's to take (no session, or already wrapped).
const panelRewrite = (options: ShellLineOptions) => {
    const hook = bashTmuxHooks(
        Object.keys(options.tools.cliEnv ?? {}),
        options.isolation,
        options.owner,
        options.tools.secrets,
        options.tools.heavyCommands,
        options.tools.offloadCommands,
    ).PreToolUse?.[0]?.hooks[0];
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

/** One turn's command runner for a loop the daemon judges: the line in the panel's session or with its references
 *  resolved in place, then under the mask while there are stored values to mask. */
export const createShellLines = (options: ShellLineOptions): ShellLines => {
    const panel = options.terminals ? panelRewrite(options) : undefined;
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

    return { line, dispose: () => masks.dispose() };
};
