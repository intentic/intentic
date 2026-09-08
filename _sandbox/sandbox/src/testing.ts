import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { HookJSONOutput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { repoRoot } from "@intentic/constants/node";
import type { ListenerContribution } from "@intentic/extension-manifest";
import type { IsolatedAgent, PersistedAgent } from "./agents/registry/agents-store.js";
import type { IsolationPlan, TurnIsolation } from "./agents/worktrees/isolation.js";
import { overlaysDir } from "./agents/worktrees/isolation.js";
import type { CodexEvent, CodexRunner, CodexTurn } from "./runtimes/codex/codex-app-server.js";
import type { Config } from "./env.config.js";

// Test-support seams specific to this daemon; the generic stand-in for a wide interface is `unstubbed` in
// @intentic/testing. Excluded from the build but type-checked via tsconfig.test.json, alongside every *.test.ts.

// Real first-party _extensions tree, so a capability fixture resolves against what the daemon ships.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

// Manifest listener contribution kept plain: tests care about the provider/event vocabulary, not the automation
// metadata, which just keeps the fixture on the public shape.
export const listenerContribution = (provider: string, eventTypes: readonly string[]): ListenerContribution => ({
    provider,
    events: eventTypes.map((type) => ({ type, label: type })),
    automation: {
        label: provider,
        channel: { label: "Channel", placeholder: "all channels" },
        starterPrompt: `Handle ${provider} events.`,
    },
});

// historyRoot alone is diverted from its default, to a temp dir, so writes stay off the real workspace.
export const testConfig: Config = {
    workspaceRoot: WORKSPACE_ROOT,
    historyRoot: join(tmpdir(), "intentic-test-history"),
    extensionsDir: EXTENSIONS_DIR,
    agentAuthDir: "",
    logLevel: "silent",
    logPretty: false,
    idleStopMinutes: 0,
    zone: "",
    connectToken: "",
    owner: { email: "" },
    syncPairToken: "",
    hostPairToken: "",
    hostPlatform: "",
    hostLabel: "",
    webOrigin: "",
    platform: { url: "", publicKey: "" },
    intenticAgentTools: "",
    claudeCodeOauthToken: "",
    anthropicApiKey: "",
    openaiApiKey: "",
    cloudflareApiToken: "",
    translator: { url: "", token: "" },
    sandbox: {
        profile: "container",
        port: 8787,
        host: "0.0.0.0",
        publicUrl: "",
        vm: false,
        grant: "",
        allowUnauthenticated: false,
        name: "",
        image: "",
        baseImage: "",
        environmentHash: "",
        channel: "",
        previousImage: "",
        definitionSeed: "",
        prewarm: false,
    },
    // No edge to dial; loopback-only is a supported posture here, not a gap.
    ingress: { url: "" },
    preview: { port: 5173 },
    google: { clientId: "" },
    acmeDirectoryUrl: "",
    intenticAgentModel: "",
    iqModelDir: "",
    iqRgPath: "",
    iqPluginDir: "",
    webqPluginDir: "",
    local: { port: 8788 },
};

// HookJSONOutput is a union; only its synchronous half carries hookSpecificOutput, the field every hook suite asserts
// on. Throws if a hook answers in the async form instead.
export const syncHookOutput = (output: HookJSONOutput): SyncHookJSONOutput => {
    if ("async" in output) {
        throw new Error("the hook answered in its async form, which carries no hookSpecificOutput");
    }
    return output;
};

// Container without CAP_SYS_ADMIN, what the worktree suites use for the symlink-mirroring fallback; planFor still
// answers WHERE the worktree sits since that is a layout fact, not a kernel one.
export const noIsolation = (root: string, historyRoot: string = HISTORY_ROOT): TurnIsolation => ({
    available: async () => false,
    planFor: async (worktree: string): Promise<IsolationPlan> => ({
        worktree,
        root,
        mirrors: [],
        overlays: overlaysDir(historyRoot, basename(worktree)),
    }),
});

// One event list per resumed turn; the last repeats if asked again. `steered[n]` is what turn n's steering channel
// delivered, drained before the turn's first yielded event so nothing races an assertion.
export const fakeCodexRunner = (...turns: readonly (readonly CodexEvent[])[]): { runner: CodexRunner; calls: CodexTurn[]; steered: string[][] } => {
    const calls: CodexTurn[] = [];
    const steered: string[][] = [];
    const runner: CodexRunner = async function* (turn) {
        calls.push(turn);
        const delivered: string[] = [];
        steered.push(delivered);
        const steering = turn.steering;
        if (steering !== undefined) {
            void (async () => {
                for await (const text of steering) {
                    delivered.push(text);
                }
            })();
        }
        yield* turns[Math.min(calls.length - 1, turns.length - 1)] ?? [];
    };
    return { runner, calls, steered };
};

// One agent card mid-life, nothing landed yet; IsolatedAgent (not PersistedAgent) since placement-reading code needs
// the branch-carrying subtype. `repos` is readonly, matching what ConversationWorktree hands back.
export const isolatedAgent = (repos: readonly PersistedAgent["repos"][number][], overrides: Partial<IsolatedAgent> = {}): IsolatedAgent => {
    const id = overrides.id ?? "c1";
    return {
        id,
        branch: `agent/${id}`,
        title: "fix the thing",
        provider: "claude",
        harness: "native",
        repos: [...repos],
        status: "idle",
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
};
