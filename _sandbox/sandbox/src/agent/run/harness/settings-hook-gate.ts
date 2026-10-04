import { dirname, join } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { inWorktree, type IsolationPlan, MAIN_MOUNT } from "../../../conversations/worktrees/isolation.js";
import { claudeCliPath } from "../../../engines/claude-sdk.js";
import { gateSettingsHooks, HOOKS_HELD_NOTE } from "../../../guard/hook-approvals.js";
import { claudeModuleReader } from "../../../guard/plugin-modules.js";
import { hookPlaceOf, type MountedPlugin, settingsHookSet } from "../../../guard/settings-hooks.js";
import type { TurnPolicy, TurnSpec } from "../../providers/agent-request.js";
import type { AgentMount } from "./agent-mounts.js";

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

// The turn's plugins whose hooks the owner approves: every mount the image does not ship (settings-hooks.ts says why).
export const gatedPlugins = (mounts: readonly AgentMount[]): MountedPlugin[] =>
    mounts.flatMap((mount): MountedPlugin[] =>
        mount.shipped || mount.origin === "builtin" ? [] : [{ name: mount.owner, from: mount.origin, dir: mount.pluginDir }],
    );

// A Claude turn's spec and policy with the settings-hook gate applied: a set the owner has not approved in this form
// switches every hook off, plugins' hooks and modules included, and the message says so.
export const withSettingsHookGate = async (
    historyRoot: string,
    conversationId: string | undefined,
    turn: GatedTurn,
    plugins: readonly MountedPlugin[] = [],
): Promise<GatedTurn> => {
    const place = hookPlaceOf(turn.spec.cwd, daemonPath(turn.spec.isolation?.plan), plugins);
    const gate = await gateSettingsHooks(historyRoot, place, conversationId, claudeModuleReader(claudeCliPath()));
    if (gate.held) {
        return { spec: { ...turn.spec, notes: [...(turn.spec.notes ?? []), HOOKS_HELD_NOTE] }, policy: { ...turn.policy, settingsHooks: { held: true } } };
    }
    const settingsHooks = { held: false, ...(gate.set === undefined ? {} : { digest: gate.set.digest }), ...(plugins.length === 0 ? {} : { plugins }) };
    return { spec: turn.spec, policy: { ...turn.policy, settingsHooks } };
};

// The sources whose edits Claude Code applies mid-session, hooks included: settings files, and skills with their
// frontmatter.
const LIVE_SOURCES = new Set(["user_settings", "project_settings", "skills"]);

const REFUSED =
    "Hooks in Claude Code's settings, skills, subagents or plugins, and the plugins its settings enable, run only once the owner approves them, from the turn after that. This change stays on disk and is not applied in this session.";

// Claude Code applies an edit to its settings or skills in the running session, so a hook written mid-turn would run
// before any gate saw it. The edit is refused unless the hook set comes out as the one this turn started with, read
// with the same mounted plugins; with every hook already off there is nothing to guard. A plugin enabled in settings
// mid-turn moves the set, so it is refused here too. A mounted plugin's own files are not reloaded mid-session: nothing
// in the daemon asks the CLI to reload plugins, and only an interactive session watches its plugin folders (an SDK one
// is not), so an edit to them waits for the next turn's gate.
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
                        const set = await settingsHookSet(hookPlaceOf(cwd, readable, policy.settingsHooks?.plugins ?? []));
                        return set?.digest === admitted ? {} : { decision: "block", reason: REFUSED };
                    },
                ],
            },
        ],
    };
};
