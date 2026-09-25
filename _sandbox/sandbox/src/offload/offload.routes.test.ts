import { type OffloadFrame, type OffloadRun, offloadRef, type RunnerCommandFrame } from "@intentic/sandbox-contract";
import { call } from "@orpc/server";
import { unstubbed } from "@intentic/testing";
import type { OrpcContext } from "../app-env.js";
import type { OffloadDeps } from "./offload.routes.js";
import { createOffloadRoutes } from "./offload.routes.js";
import { DEFAULT_HEAVY_COMMANDS } from "../platform/resources/heavy-commands.js";

// This sandbox's side of an offloaded command: whether a runner can take it, the runner's frames relayed unchanged, and
// every way a runner cannot take it after all answering with one refusal, which sends the line back here.

const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/offload/runs" };

interface FakeRunner {
    readonly frames?: readonly RunnerCommandFrame[];
    readonly fails?: Error;
    readonly cancelled: string[];
}

const world = (runners: Record<string, FakeRunner | "offline">) => {
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
        }),
        logger: unstubbed<OffloadDeps["logger"]>("logger", { warn: () => undefined }),
        heavyCommands: unstubbed<OffloadDeps["heavyCommands"]>("heavyCommands", { read: async () => DEFAULT_HEAVY_COMMANDS }),
    };
    return createOffloadRoutes(deps);
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
        const old = world({ "runner-omen": { fails: new Error("Not Found"), cancelled: [] } });
        expect(await frames(old, run("runner-omen"))).toEqual([{ kind: "refused", why: expect.stringContaining("predates offloading") }]);
    });
});

test("the kinds that can run elsewhere are the rules that queue, never the ones that exempt a line", async () => {
    const { kinds } = await call(world({}).kinds, undefined, { context });
    expect(kinds.map(({ id }) => id)).toEqual(["repo-verify", "vitest", "typechecker", "turbo-fanout", "package-script"]);
});
