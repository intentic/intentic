import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { HookJSONOutput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { repoRoot } from "@intentic/constants/node";
import type { ListenerContribution } from "@intentic/extension-manifest";
import type { IsolatedAgent, PersistedAgent } from "./agents/agents-store.js";
import type { IsolationPlan, TurnIsolation } from "./agents/isolation.js";
import { overlaysDir } from "./agents/isolation.js";
import type { CodexEvent, CodexRunner, CodexTurn } from "./codex/codex-app-server.js";
import type { Config } from "./env.config.js";

/* Test-support seams shared across this package's suites, the ones that stand in for something specific to
 * THIS daemon. The generic stand-in for any wide interface is `unstubbed` in `@intentic/testing`; import it
 * from there. Not part of the build (tsconfig `exclude`, like e2e-harness.ts), but IS type-checked,
 * tsconfig.test.json puts this file and every *.test.ts in one program.
 *
 * It exists because the same fake was being written out longhand in file after file: four copies of a
 * `TurnIsolation` here, six of a throwing API table over in _deploy/providers. A copy cannot be updated when the
 * seam it stands in for grows a method, so each one quietly starts describing a daemon that no longer exists
 *, `planFor` kept returning `undefined` in all four copies for as long as it took someone to notice, which
 * the interface's own comment records as the bug that made isolation silently do nothing. One definition per
 * seam, and the compiler now says so at the definition instead of at a route three layers away.
 */

// The real first-party connectors/discord extensions, so a cli capability's image fragment and a
// cli-capability test's provider data both resolve against the tree the daemon actually ships.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

// A manifest listener contribution whose wording is deliberately plain: route/process tests care about the
// provider and event vocabulary, while the required automation metadata keeps the fixture on the public shape.
export const listenerContribution = (provider: string, eventTypes: readonly string[]): ListenerContribution => ({
    provider,
    events: eventTypes.map((type) => ({ type, label: type })),
    automation: {
        label: provider,
        channel: { label: "Channel", placeholder: "all channels" },
        starterPrompt: `Handle ${provider} events.`,
    },
});

/* Every config field at its schema default. Config is DATA, not a seam of methods, so it is spelled out whole
 * rather than stood in for: `unstubbed` answers an unread key with a throwing FUNCTION, which a `if
 * (config.publicUrl)` branch would read as set. One copy for the package, a suite that cares about a field
 * spreads this and overrides it, and a suite that doesn't gets the same inert defaults every other one sees.
 *
 * `historyRoot` is the ONE field held away from its schema default (/history), because that default names a
 * live volume of the machine running the suite, and this daemon is dogfooded, so that machine is a real
 * sandbox with real agents on it. A route test only has to reach a handler that WRITES under the history root
 * to write the running workspace's own state: the git routes' scan converges root's exclude list there
 * (syncRootExcludes) from whatever repos the test's temp workspace holds, which left the live root repo
 * excluding "intent" and "shop" and, until the daemon's next scan re-derived it, staging every real repo of
 * the workspace into root's index as a gitlink. Under a path that does not exist, every such write is the
 * no-op the test always meant it to be.
 */
export const testConfig: Config = {
    workspaceRoot: WORKSPACE_ROOT,
    historyRoot: join(tmpdir(), "intentic-test-history"),
    extensionsDir: EXTENSIONS_DIR,
    agentAuthDir: "",
    logLevel: "silent",
    logPretty: false,
    idleStopMinutes: 0,
    zrok: { token: "", api: "", namespace: "" },
    zone: "",
    connectToken: "",
    owner: { email: "" },
    syncPairToken: "",
    hostPairToken: "",
    hostPlatform: "",
    hostLabel: "",
    webOrigin: "",
    platform: { url: "" },
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
        allowUnauthenticated: false,
        name: "",
        image: "",
        baseImage: "",
        environmentHash: "",
        channel: "",
        previousImage: "",
        definitionSeed: "",
    },
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

/* What a hook the daemon installs actually returns. `HookJSONOutput` is a union, and only its SYNCHRONOUS side
 * carries `hookSpecificOutput`, the field every hook suite here asserts on. Reading it off the union is what
 * the type checker refuses; saying which side is meant, and failing loudly if a hook ever answers with the
 * other one, is what the suites already assume.
 */
export const syncHookOutput = (output: HookJSONOutput): SyncHookJSONOutput => {
    if ("async" in output) {
        throw new Error("the hook answered in its async form, which carries no hookSpecificOutput");
    }
    return output;
};

/* A container without CAP_SYS_ADMIN, which is what every test runner gets, and what the worktree suites
 * assert the symlink-mirroring fallback against. `planFor` still answers: WHERE the worktree sits is a fact
 * about the layout, not about the kernel, and the redirect layer needs the same answer the mounts would have
 * used (isolation.ts, TurnIsolation.planFor).
 */
export const noIsolation = (root: string, historyRoot: string = HISTORY_ROOT): TurnIsolation => ({
    available: async () => false,
    planFor: async (worktree: string): Promise<IsolationPlan> => ({
        worktree,
        root,
        mirrors: [],
        overlays: overlaysDir(historyRoot, basename(worktree)),
    }),
});

/* One fake for the provider-private turn seam. Plan-mode suites supply one event list per resumed turn; the
 * final list repeats if a flow asks again, which keeps rejection-loop fixtures focused on only the turns used.
 *
 * `steered[n]` is what turn n's steering channel delivered, how a suite sees WHICH turn a mid-turn message
 * reached, which for a plan turn is the whole question (one typed while the plan is being read belongs to the
 * execution phase, not to the phase that has already closed). Drained in the background, as the real runner's
 * pump does; the channel's messages land before the turn's first yielded event, so nothing races an assertion. */
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

/* One agent card, mid-life: a branch of its own, a turn's worth of counters at zero, nothing landed yet. It is
 * an IsolatedAgent rather than a PersistedAgent because every path that reads an agent's PLACEMENT (land, the
 * standings, origins) takes the branch-carrying subtype, and a fixture that returns the supertype only ever
 * type-checks by accident. `repos` is readonly: a ConversationWorktree hands its own back that way.
 */
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
