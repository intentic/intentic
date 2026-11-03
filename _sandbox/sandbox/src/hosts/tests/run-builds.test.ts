import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { createRunBuilds, MAX_HOLD_MS, RENEW_LAPSE_MS, waitingLine } from "../runs/run-builds.js";
import { deviceRunRawRoutes, stopperName } from "../runs/device-runs.routes.js";

// While a run builds in the owner's tree, lands into that repository wait; a hold that is not renewed, or that outlives
// any build, lets them go by itself.

const settledWithin = async (wait: Promise<void>, ms: number): Promise<boolean> =>
    await Promise.race([wait.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), ms))]);

test("a land into a held repository waits for the build, one into another goes at once", async () => {
    const builds = createRunBuilds();
    const hold = builds.hold({ repo: "game", target: "server", device: "rog" });
    const heard: string[] = [];
    const waiting = builds.settled(["game", "site"], (holds) => heard.push(waitingLine(holds)));
    expect(await settledWithin(builds.settled(["site"]), 50)).toBe(true);
    expect(await settledWithin(waiting, 50)).toBe(false);
    expect(heard).toEqual([expect.stringContaining("Waiting for the Run build of server (on rog) to finish compiling game")]);
    builds.landed(["game"]);
    expect(builds.release(hold.id)).toEqual({ waited: 1, landedDuring: 1 });
    expect(await settledWithin(waiting, 50)).toBe(true);
    // Released twice is nothing the second time.
    expect(builds.release(hold.id)).toBeUndefined();
});

test("a hold nobody renews lapses, and a renewed one still ends at its cap", () => {
    jest.useFakeTimers();
    try {
        const builds = createRunBuilds();
        const quiet = builds.hold({ repo: "game", target: "server", device: "rog" });
        jest.advanceTimersByTime(RENEW_LAPSE_MS + 1);
        expect(builds.renew(quiet.id)).toBe(false);
        const busy = builds.hold({ repo: "game", target: "server", device: "rog" });
        for (let at = 0; at < MAX_HOLD_MS; at += RENEW_LAPSE_MS / 2) {
            jest.advanceTimersByTime(RENEW_LAPSE_MS / 2);
            builds.renew(busy.id);
        }
        jest.advanceTimersByTime(RENEW_LAPSE_MS / 2);
        expect(builds.renew(busy.id)).toBe(false);
    } finally {
        jest.useRealTimers();
    }
});

test("the lands since a moment are counted per repository", () => {
    let now = 1_000;
    const builds = createRunBuilds(() => now);
    builds.landed(["game"]);
    now = 2_000;
    builds.landed(["game", "site"]);
    expect([builds.landsSince("game", 500), builds.landsSince("game", 1_000), builds.landsSince("site", 0), builds.landsSince("other", 0)]).toEqual([2, 1, 1, 0]);
});

test("who stopped a program is said by the door and the caller", () => {
    expect(stopperName("the Run dialog", "replace")).toBe("Run pressed again in the Run dialog (its new build replaced it)");
    expect(stopperName("the Run dialog", "interrupt")).toBe("Ctrl+C in its Run terminal");
    expect(stopperName("conversation coral-maple-kmq3", "replace")).toBe("`devices run` from conversation coral-maple-kmq3, whose new build replaced it");
    expect(stopperName("conversation coral-maple-kmq3", "stop")).toBe("`devices stop` from conversation coral-maple-kmq3");
});

// Whose tree a build compiles decides whether it holds lands: an isolated conversation's own checkout takes none.
test("a build holds the repository of the owner's tree it stands in, and an isolated conversation's build holds none", async () => {
    const builds = createRunBuilds();
    const isolated = { placement: { kind: "worktree" } };
    const routes = deviceRunRawRoutes(
        unstubbed<Parameters<typeof deviceRunRawRoutes>[0]>("services", {
            runBuilds: builds,
            workspace: unstubbed<Services["workspace"]>("workspace", { root: WORKSPACE_ROOT }),
            // SAFETY: only `placement.kind` is read of the record, to tell an isolated conversation.
            agents: unstubbed<Services["agents"]>("agents", { entry: (id: string) => (id === "iso" ? (isolated as never) : undefined) }),
        }),
    );
    const app = new Hono<AppEnv>();
    app.post("/devices/builds", routes["POST /devices/builds"]);
    // SAFETY: the route answers JSON of this shape (device-runs.routes.ts createBuildHoldRoutes).
    const hold = async (body: object, headers: Record<string, string>): Promise<{ held: boolean; repo?: string; why?: string }> =>
        (await (await app.request("/devices/builds", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } })).json()) as {
            held: boolean;
        };
    const build = { target: "server", device: "rog" };
    expect(await hold({ ...build, dir: `${WORKSPACE_ROOT}/game` }, { "x-intentic-conversation": "iso" })).toEqual({ held: false, why: expect.stringContaining("own checkout") });
    expect(await hold({ ...build, dir: "/elsewhere" }, {})).toEqual({ held: false, why: "/elsewhere is outside the workspace" });
    expect(await hold({ ...build, dir: WORKSPACE_ROOT }, { "x-intentic-conversation": "home" })).toMatchObject({ held: true, repo: "root" });
    // The editor's run names its repository, and a grant is never an isolated conversation's.
    expect(await hold({ ...build, dir: `${WORKSPACE_ROOT}/game/sub`, repo: "game" }, { "x-intentic-run-grant": "g", "x-intentic-conversation": "iso" })).toMatchObject({
        held: true,
        repo: "game",
    });
});
