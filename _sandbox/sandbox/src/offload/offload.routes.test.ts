import type { OffloadFrame, OffloadRun } from "@intentic/sandbox-contract/schemas/offload";
import { offloadRef, type RunnerCommandFrame,type RunnerFacts } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { call } from "@orpc/server";
import { unstubbed } from "@intentic/testing";
import type { OrpcContext } from "../app-env.js";
import type { OffloadDeps } from "./offload.routes.js";
import { createOffloadRoutes } from "./offload.routes.js";
import { failureOf, orpcLink } from "../peers/orpc-link.testing.js";
import { mergeHeavyRules } from "@intentic/constants/heavy-rules";
import { measureHereForTest } from "../runners/fleet-advice.js";
import { type CommandProfiles, commandKey, type Measured } from "./command-profiles.js";

// This sandbox's side of an offloaded command: whether a runner can take it, the runner's frames relayed unchanged, and
// every way a runner cannot take it after all answering with one refusal, which sends the line back here.

const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/offload/runs" };

interface FakeRunner {
    readonly frames?: readonly RunnerCommandFrame[];
    readonly fails?: Error;
    readonly cancelled: string[];
}

// How full each machine is, for a kind sent to any machine with room; absent facts are a runner never measured.
const QUIET: RunnerFacts = { cpus: 8, memoryMb: 32_768, freeDiskMb: 100_000, load: 0.1, memoryFreeMb: 28_000 };
const SWAMPED: RunnerFacts = { ...QUIET, cpus: 16, load: 2 };

// Profiles in memory, keyed the way the file keeps them; `recorded` is every measurement handed in.
const memoryProfiles = (peaks: Record<string, number> = {}) => {
    const recorded: Array<{ readonly key: string; readonly measured: Measured }> = [];
    const profiles: CommandProfiles = {
        lookup: async (label, command) => {
            const key = commandKey(label, command);
            return peaks[key] === undefined ? undefined : { key, runs: 1, peakMemoryMb: peaks[key], lastAt: 0 };
        },
        record: async (label, command, measured) => {
            recorded.push({ key: commandKey(label, command), measured });
        },
        list: async () => [],
    };
    return { profiles, recorded };
};

const world = (runners: Record<string, FakeRunner | "offline">, facts: Record<string, RunnerFacts> = {}, profiles: CommandProfiles = memoryProfiles().profiles) => {
    const deps: OffloadDeps = {
        runners: unstubbed<OffloadDeps["runners"]>("runners", {
            list: async () => Object.keys(runners).map((id) => ({ id, host: id === "runner-omen" ? "omen" : undefined })) as never,
        }),
        runnerHub: unstubbed<OffloadDeps["runnerHub"]>("runnerHub", {
            client: (id: string) => {
                const runner = runners[id];
                if (runner === undefined || runner === "offline") {
                    return undefined;
                }
                return {
                    runCommand: async () => {
                        if (runner.fails !== undefined) {
                            throw runner.fails;
                        }
                        return (async function* () {
                            yield* runner.frames ?? [];
                        })();
                    },
                    cancelCommand: async ({ runId }: { runId: string }) => {
                        runner.cancelled.push(runId);
                        return { ok: true };
                    },
                } as never;
            },
            refresh: async () => undefined,
            // SAFETY: the fleet reading touches only `online` and `facts` of a runner's state.
            state: (id: string) => (runners[id] === undefined || runners[id] === "offline" ? { online: false } : { online: true, facts: facts[id] }) as never,
        }),
        logger: unstubbed<OffloadDeps["logger"]>("logger", { warn: () => undefined }),
        heavyCommands: unstubbed<OffloadDeps["heavyCommands"]>("heavyCommands", { read: async () => mergeHeavyRules() }),
        // What the fleet reading counts: no turn running anywhere, so only the facts decide.
        conversations: unstubbed<OffloadDeps["conversations"]>("conversations", { inFlightByRunner: () => new Map(), activeTurnCount: () => 0 }),
        resources: unstubbed<OffloadDeps["resources"]>("resources", {}),
        privacyShield: unstubbed<OffloadDeps["privacyShield"]>("privacyShield", {}),
        sandboxSettings: unstubbed<OffloadDeps["sandboxSettings"]>("sandboxSettings", {}),
        workspace: unstubbed<OffloadDeps["workspace"]>("workspace", {}),
        commandProfiles: profiles,
    };
    return createOffloadRoutes(deps);
};

// What a runner built before offloading answers runCommand with, from a real oRPC peer whose router has no such procedure.
const missingProcedureError = async (): Promise<Error> => {
    const { client, close } = await orpcLink<{ runCommand: () => Promise<never> }>({});
    try {
        return await failureOf(client.runCommand());
    } finally {
        close();
    }
};

const run = (runner: string): OffloadRun => ({
    runner,
    runId: "run-0000abcd",
    repo: "intentic",
    ref: offloadRef("run-0000abcd"),
    cwd: "_editor/web",
    command: "pnpm test src/app",
    env: {},
    exports: [],
    outputs: [],
    have: {},
    label: "bun-test",
});

const frames = async (routes: ReturnType<typeof world>, input: OffloadRun): Promise<OffloadFrame[]> => {
    const seen: OffloadFrame[] = [];
    for await (const frame of await call(routes.run, input, { context })) {
        seen.push(frame);
    }
    return seen;
};

describe("whether a runner can take a command", () => {
    test("is yes for a connected runner, named by the machine that asked for it", async () => {
        const routes = world({ "runner-omen": { cancelled: [] } });
        expect(await call(routes.target, { runner: "runner-omen" }, { context })).toEqual({ runner: "runner-omen", name: "omen", ready: true });
    });

    test("is no, saying why, for one that is offline or no longer set up", async () => {
        const routes = world({ "runner-omen": "offline" });
        expect(await call(routes.target, { runner: "runner-omen" }, { context })).toMatchObject({ ready: false, why: expect.stringContaining("omen is offline") });
        expect(await call(routes.target, { runner: "runner-gone" }, { context })).toMatchObject({ ready: false, why: expect.stringContaining("no runner") });
    });
});

// "Any machine with room" (settings `offload.commands` set to "auto"): decided as each command starts.
describe("whether any machine with room can take a command", () => {
    afterEach(() => measureHereForTest(undefined));

    test("is no, with no reason to print, while this sandbox is calm", async () => {
        measureHereForTest(async () => QUIET);
        const routes = world({ "runner-omen": { cancelled: [] } }, { "runner-omen": QUIET });
        expect(await call(routes.target, { runner: "auto" }, { context })).toEqual({ runner: "auto", name: "this sandbox", ready: false });
    });

    test("is the roomiest runner while this sandbox is busy, by its own id and its machine's name", async () => {
        measureHereForTest(async () => SWAMPED);
        const routes = world({ "runner-omen": { cancelled: [] }, "runner-z440": { cancelled: [] } }, { "runner-omen": QUIET, "runner-z440": { ...QUIET, load: 1 } });
        expect(await call(routes.target, { runner: "auto" }, { context })).toEqual({ runner: "runner-omen", name: "omen", ready: true });
    });

    test("never picks a machine short of what the command needs, and leaves a calm sandbox for one that has it", async () => {
        const GPU: RunnerFacts = { ...QUIET, gpus: [{ name: "RTX 3080", memoryMb: 16_384 }] };
        measureHereForTest(async () => ({ ...QUIET, gpus: [] }));
        const routes = world({ "runner-omen": { cancelled: [] }, "runner-z440": { cancelled: [] } }, { "runner-omen": QUIET, "runner-z440": GPU });
        // This sandbox is calm, yet it has no GPU: the one runner with one takes it.
        expect(await call(routes.target, { runner: "auto", gpu: "true" }, { context })).toMatchObject({ runner: "runner-z440", ready: true });
        // No machine has 64 GiB free: here, saying why.
        expect(await call(routes.target, { runner: "auto", memoryMb: 65_536 }, { context })).toMatchObject({ ready: false, why: expect.stringContaining("64 GiB") });
    });

    test("plans by the most memory the same kind of command held on its last runs", async () => {
        measureHereForTest(async () => ({ ...QUIET, memoryLimitMb: 18_432 }));
        const command = "cargo test -p shinobi-society -- visibility::tests";
        const { profiles } = memoryProfiles({ [commandKey("cargo-verify", command)]: 20_000 });
        const routes = world({ "runner-omen": { cancelled: [] }, "runner-z440": { cancelled: [] } }, { "runner-omen": QUIET, "runner-z440": { ...QUIET, memoryFreeMb: 12_000 } }, profiles);
        // 20 GB does not fit this 18 GB sandbox, nor z440's 12 GB free: omen, calm sandbox or not.
        expect(await call(routes.target, { runner: "auto", label: "cargo-verify", command: "cargo test -p shinobi-society -- other::filter" }, { context })).toMatchObject({
            runner: "runner-omen",
            ready: true,
        });
    });

    test("picks the roomiest runner that fits while this sandbox is calm when asked in so many words, or says why it cannot", async () => {
        measureHereForTest(async () => QUIET);
        const routes = world({ "runner-omen": { cancelled: [] } }, { "runner-omen": QUIET });
        expect(await call(routes.target, { runner: "auto", eager: "true" }, { context })).toMatchObject({ runner: "runner-omen", ready: true });
        expect(await call(world({}).target, { runner: "auto", eager: "true" }, { context })).toMatchObject({ ready: false, why: "no runner is set up on another machine" });
    });

    test("checks a runner named outright against what the command needs", async () => {
        const routes = world({ "runner-omen": { cancelled: [] } }, { "runner-omen": { ...QUIET, gpus: [] } });
        expect(await call(routes.target, { runner: "runner-omen", gpu: "true" }, { context })).toMatchObject({ ready: false, why: "omen has no GPU this command can use" });
    });

    test("stays here in silence when no runner is better off, or none is online", async () => {
        measureHereForTest(async () => SWAMPED);
        expect(await call(world({ "runner-omen": { cancelled: [] } }, { "runner-omen": SWAMPED }).target, { runner: "auto" }, { context })).toMatchObject({ ready: false });
        const offline = await call(world({ "runner-omen": "offline" }).target, { runner: "auto" }, { context });
        expect(offline).toMatchObject({ ready: false });
        expect(offline.why).toBeUndefined();
    });
});

describe("an offloaded run", () => {
    test("relays the runner's frames unchanged and files the run with its end", async () => {
        const said: RunnerCommandFrame[] = [
            { kind: "status", text: "intentic: fetching the snapshot…" },
            { kind: "output", stream: "stdout", text: "1 pass\n" },
            { kind: "exit", code: 0, ran: true, files: {} },
        ];
        const routes = world({ "runner-omen": { frames: said, cancelled: [] } });
        expect(await frames(routes, run("runner-omen"))).toEqual(said);
        const { runs } = await call(routes.runs, undefined, { context });
        expect(runs).toEqual([
            { runId: "run-0000abcd", runner: "runner-omen", name: "omen", label: "bun-test", command: "pnpm test src/app", startedAt: expect.any(Number), endedAt: expect.any(Number), code: 0 },
        ]);
    });

    test("keeps what the runner measured, on the run's record and in its kind's profile", async () => {
        const { profiles, recorded } = memoryProfiles();
        const routes = world({ "runner-omen": { frames: [{ kind: "exit", code: 0, ran: true, files: {}, peakMemoryMb: 7_100, durationMs: 93_000 }], cancelled: [] } }, {}, profiles);
        await frames(routes, run("runner-omen"));
        expect(recorded).toEqual([{ key: commandKey("bun-test", "pnpm test src/app"), measured: { peakMemoryMb: 7_100, durationMs: 93_000 } }]);
        const { runs } = await call(routes.runs, undefined, { context });
        expect(runs[0]).toMatchObject({ peakMemoryMb: 7_100, durationMs: 93_000, code: 0 });
    });

    test("is refused, so it runs here, when the runner is offline or predates offloading", async () => {
        expect(await frames(world({ "runner-omen": "offline" }), run("runner-omen"))).toEqual([{ kind: "refused", why: expect.stringContaining("offline") }]);
        const old = world({ "runner-omen": { fails: await missingProcedureError(), cancelled: [] } });
        expect(await frames(old, run("runner-omen"))).toEqual([{ kind: "refused", why: expect.stringContaining("predates offloading") }]);
    });

    // Another program's "not found" (a missing repository, a missing file) is a failed link, not an old runner.
    test("is refused as a failed link, in its own words, when the runner fails with anything else not found", async () => {
        const failed = world({ "runner-omen": { fails: new Error("remote: Repository not found."), cancelled: [] } });
        expect(await frames(failed, run("runner-omen"))).toEqual([{ kind: "refused", why: "the link to omen failed: remote: Repository not found." }]);
    });
});

test("the kinds that can run elsewhere are the rules that queue, never the ones that exempt a line", async () => {
    const { kinds } = await call(world({}).kinds, undefined, { context });
    expect(kinds.map(({ id }) => id)).toEqual([
        "repo-verify",
        "vue-typecheck-changed",
        "editor-typecheck",
        "editor-typecheck-here",
        "vitest",
        "typechecker",
        "turbo-fanout",
        "package-script",
        "cargo",
    ]);
});
