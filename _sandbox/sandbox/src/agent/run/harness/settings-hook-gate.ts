import { dirname, join } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { inWorktree, type IsolationPlan, MAIN_MOUNT } from "../../../agents/worktrees/isolation.js";
import { gateSettingsHooks, HOOKS_HELD_NOTE } from "../../../guard/hook-approvals.js";
import { hookPlaceOf, settingsHookSet } from "../../../guard/settings-hooks.js";
import type { TurnPolicy, TurnSpec } from "../../providers/agent-request.js";

// The file the daemon opens for a path the turn's namespace names: its worktree where the namespace put the root, the
// real root behind MAIN_MOUNT.
const daemonPath =
    (plan: IsolationPlan | undefined) =>
    (path: string): string =>
        plan !== undefined && path.startsWith(`${MAIN_MOUNT}/`) ? join(plan.root, path.slice(MAIN_MOUNT.length + 1)) : inWorktree(path, plan);

interface GatedTurn {
    readonly spec: TurnSpec;
    readonly policy: TurnPolicy;
}

// A Claude turn's spec and policy with the settings-hook gate applied: a set the owner has not approved in this form
// switches every hook off, and the message says so.
export const withSettingsHookGate = async (historyRoot: string, conversationId: string | undefined, turn: GatedTurn): Promise<GatedTurn> => {
    const gate = await gateSettingsHooks(historyRoot, hookPlaceOf(turn.spec.cwd, daemonPath(turn.spec.isolation?.plan)), conversationId);
    if (gate.held) {
        return { spec: { ...turn.spec, notes: [...(turn.spec.notes ?? []), HOOKS_HELD_NOTE] }, policy: { ...turn.policy, settingsHooks: { held: true } } };
    }
    return { spec: turn.spec, policy: { ...turn.policy, settingsHooks: { held: false, ...(gate.set === undefined ? {} : { digest: gate.set.digest }) } } };
};

// The sources whose edits Claude Code applies mid-session, hooks included: settings files, and skills with their
// frontmatter.
const LIVE_SOURCES = new Set(["user_settings", "project_settings", "skills"]);

const REFUSED =
    "Hooks in Claude Code's settings, skills or subagents run only once the owner approves them, from the turn after that. This change stays on disk and is not applied in this session.";

// Claude Code applies an edit to its settings or skills in the running session, so a hook written mid-turn would run
// before any gate saw it. The edit is refused unless the hook set comes out as the one this turn started with; with
// every hook already off there is nothing to guard.
export const settingsHookChangeHooks = ({ spec, policy }: GatedTurn): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    if (policy.settingsHooks?.held === true) {
        return {};
    }
    const admitted = policy.settingsHooks?.digest;
    const readable = daemonPath(spec.isolation?.plan);
    return {
        ConfigChange: [
            {
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "ConfigChange" || !LIVE_SOURCES.has(input.source)) {
                            return {};
                        }
                        // A project file changed wherever the session now stands; everything else is read where it began.
                        const file = input.source === "project_settings" ? input.file_path : undefined;
                        const cwd = file?.endsWith("/.claude/settings.json") === true ? dirname(dirname(file)) : spec.cwd;
                        const set = await settingsHookSet(hookPlaceOf(cwd, readable));
                        return set?.digest === admitted ? {} : { decision: "block", reason: REFUSED };
                    },
                ],
            },
        ],
    };
};
