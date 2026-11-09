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

const world = (runners: Record<string, FakeRunner | "offline">, facts: Record<string, RunnerFacts> = {}) => {
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
