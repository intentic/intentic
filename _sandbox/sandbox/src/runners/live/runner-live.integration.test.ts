import { runnerContract } from "@intentic/sandbox-contract/contracts/runner.contract";
import type { RunnerFeedFrame } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { AgentJob, AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import type { RuntimeDomain } from "@intentic/sandbox-contract/state/runtime-state";
import { implement, ORPCError } from "@orpc/server";
import type { Caller } from "../../auth/auth.js";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import { failureOf, orpcLink } from "../../peers/orpc-link.testing.js";
import type { RunnerClient } from "../runner-peer.js";
import { createRunnerViewTickets } from "../uplink/runner-view-tickets.js";
import { closeRunnerBrowser, openRunnerBrowser, runnerBrowserTab, runnerBrowserSessions, runnerDesktops, runnerWindowOf } from "./runner-browsers.js";
import { followRunnerFeed, type RunnerFeedDeps } from "./runner-feed.js";
import { runnerFeed } from "./runner-live-doors.js";
import { forwardRunnerPort } from "./runner-ports.js";
import { tellRunnersRevoked } from "./runner-revoke.js";
import { stopOnRunner } from "./runner-stops.js";
import { openRunnerView } from "./runner-views.routes.js";

/* A RUNNER CONVERSATION'S LIVE VIEWS at the seams between the parent and its runner (2026-11-23): the feed that brings a
   runner's jobs and watches to the parent's card, the stops carried back, the browsers and desktop merged into the
   parent's lists, a runner port's preview, the view route, and revocation. The runner's side is a real oRPC socket where
   the transport matters (a stream, an older runner's NOT_FOUND); elsewhere a client double. */

// A double of whatever a seam reads.
// SAFETY: each seam under test reads only the members its double carries; a missing one fails the test that reached it.
const double = <T>(value: object): T => value as T;

const job = (id: string): AgentJob => ({ id, label: `job ${id}`, session: `job-${id}`, startedAt: 1 });
const summary = (id: string, jobs: string[] = []): AgentSummary => double<AgentSummary>({ id, jobs: jobs.map(job) });
// A conversation placed on `runner`, or one that runs here.
const placed = (id: string, runner: string | undefined): PersistedAgent =>
    double<PersistedAgent>({
        id,
        placement: runner === undefined ? { kind: "main" } : { kind: "worktree", runner, repos: [] },
        identity: {},
        social: {},
    });

// The doors a runner double answers.
type Doors = { readonly [K in keyof RunnerClient]?: (input: never) => Promise<object> };
const hubOf = (clients: Readonly<Record<string, Doors>>) => ({
    client: (id: string): RunnerClient | undefined => (clients[id] === undefined ? undefined : double<RunnerClient>(clients[id])),
    offline: (id: string) => `The runner "${id}" is offline.`,
});
const storeOf = (...ids: string[]) => ({ list: async () => ids.map((id) => ({ id })) });
const notFound = async (): Promise<never> => {
    throw new ORPCError("NOT_FOUND");
};
const quiet = { info: () => undefined };
// A door that notes what it was asked and answers `answer`.
const noting =
    <T extends object>(asked: object[], answer: T) =>
    async (input: object): Promise<T> => {
        asked.push(input);
        return answer;
    };
const until = async (ready: () => boolean): Promise<void> => {
    while (!ready()) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

describe("the runner's feed", () => {
    test("says what it holds at once, then each change, then a conversation gone, and its browsers' and desktop's changes", async () => {
        let roster: ((agents: AgentSummary[], rev: number, whole: boolean) => void) | undefined;
        let runtime: ((domains: RuntimeDomain[]) => void) | undefined;
        const abort = new AbortController();
        const feed = runnerFeed(
            {
                subscribeRoster: (listener) => {
                    roster = listener;
                    listener([summary("c1", ["j1"]), summary("c2")], 1, true);
                    return () => (roster = undefined);
                },
                onRuntimeChange: (listener) => {
                    runtime = listener;
                    return () => (runtime = undefined);
                },
            },
            abort.signal,
        );
        const frames: (RunnerFeedFrame | undefined)[] = [(await feed.next()).value ?? undefined];
        // c2 stays empty, so nothing is said of it; c3 gains a job; then c1 leaves the roster.
        roster?.([summary("c1", ["j1"]), summary("c2"), summary("c3", ["j9"])], 2, false);
        roster?.([summary("c3", ["j9"])], 3, true);
        runtime?.(["terminals", "browsers"]);
        for (let at = 0; at < 3; at += 1) {
            frames.push((await feed.next()).value ?? undefined);
        }
        expect(frames).toEqual([
            { kind: "cards", cards: [{ conversationId: "c1", jobs: [job("j1")], watches: [] }] },
            { kind: "card", card: { conversationId: "c3", jobs: [job("j9")], watches: [] } },
            { kind: "card", card: { conversationId: "c1", jobs: [], watches: [] } },
            { kind: "changed", domain: "browsers" },
        ]);
        abort.abort();
        expect((await feed.next()).done).toBe(true);
        expect(roster).toBeUndefined();
        expect(runtime).toBeUndefined();
    });

    test("is filed by the parent on the cards of the conversations placed on that runner alone, and cleared when it ends", async () => {
        const os = implement(runnerContract);
        const router = {
            feed: os.feed.handler(async function* () {
                yield {
                    kind: "cards",
                    cards: [
                        { conversationId: "mine", jobs: [job("j1")], watches: [] },
                        { conversationId: "theirs", jobs: [job("j2")], watches: [] },
                    ],
                };
                yield { kind: "card", card: { conversationId: "here", jobs: [job("j3")], watches: [] } };
                yield { kind: "card", card: { conversationId: "mine", jobs: [job("j1"), job("j4")], watches: [] } };
                await new Promise(() => undefined);
            }),
        };
        const link = await orpcLink<RunnerClient>(router);
        const entries = new Map([placed("mine", "r1"), placed("theirs", "r2"), placed("here", undefined)].map((entry) => [entry.id, entry]));
        const sent: { id: string; jobs: number }[] = [];
        const deps = double<RunnerFeedDeps>({
            agents: { entry: (id: string) => entries.get(id) },
            conversations: { send: (id: string, event: { jobs: readonly AgentJob[] }) => sent.push({ id, jobs: event.jobs.length }) },
            logger: quiet,
        });
        const following = followRunnerFeed(deps, "r1", link.client);
        await until(() => sent.length === 2);
        expect(sent).toEqual([
            { id: "mine", jobs: 1 },
            { id: "mine", jobs: 2 },
        ]);
        // The socket goes: what the feed filed is cleared, and the runner says it again once it is back.
        await link.drop();
        await following;
        expect(sent.at(-1)).toEqual({ id: "mine", jobs: 0 });
        link.close();
    });

    test("from an older runner without the door files nothing and logs nothing", async () => {
        const os = implement(runnerContract);
        const link = await orpcLink<RunnerClient>({ ping: os.ping.handler(() => ({ ok: true })) });
        const sent: string[] = [];
        const logged: object[] = [];
        const deps = double<RunnerFeedDeps>({
            agents: { entry: () => undefined },
            conversations: { send: (id: string) => sent.push(id) },
            logger: { info: (fields: object) => logged.push(fields) },
        });
        await followRunnerFeed(deps, "old", link.client);
        expect(sent).toEqual([]);
        expect(logged).toEqual([]);
        link.close();
    });
});

describe("a stop on a runner conversation's card", () => {
    test("is carried to its runner, and says whether anything stopped there", async () => {
        const asked: object[] = [];
        const runnerHub = hubOf({
            r1: {
                stopJob: noting(asked, { stopped: true }),
                stopWatching: noting(asked, { stopped: false }),
            },
        });
        expect(await stopOnRunner({ runnerHub }, placed("c1", "r1"), { kind: "job", jobId: "j1" })).toEqual({ stopped: true });
        expect(await stopOnRunner({ runnerHub }, placed("c1", "r1"), { kind: "watch", watchId: undefined })).toEqual({ stopped: false });
        expect(asked).toEqual([{ conversationId: "c1", jobId: "j1" }, { conversationId: "c1" }]);
        // A conversation that runs here is not the runner's to stop.
        expect(await stopOnRunner({ runnerHub }, placed("c2", undefined), { kind: "job", jobId: "j1" })).toEqual({ stopped: false });
    });

    test("stops nothing and says why when its runner is away, or older than the door, never throwing", async () => {
        const away = await stopOnRunner({ runnerHub: hubOf({}) }, placed("c1", "r1"), { kind: "watch", watchId: undefined });
        expect(away.stopped).toBe(false);
        expect(away.reason).toContain("offline");
        const old = await stopOnRunner({ runnerHub: hubOf({ r1: { stopJob: notFound } }) }, placed("c1", "r1"), { kind: "job", jobId: "j1" });
        expect(old.stopped).toBe(false);
        expect(old.reason).toContain("update the runner");
    });
});

describe("a runner's browsers and desktop on the parent's lists", () => {
    const window = (name: string): BrowserSession => ({ name, label: "a page", server: "playwright", running: true, activityAt: 1, pages: [] });

    test("are merged under names that cannot collide, an older or failing runner left out", async () => {
        const deps = {
            logger: quiet,
            runners: storeOf("r1", "old", "broken", "asleep"),
            runnerHub: hubOf({
                r1: { browsers: async () => ({ sessions: [window("own")] }), desktop: async () => ({ running: true, windows: 2 }) },
                old: { browsers: notFound, desktop: notFound },
                broken: {
                    browsers: async () => {
                        throw new Error("socket closed");
                    },
                    desktop: notFound,
                },
            }),
        };
        expect(await runnerBrowserSessions(deps)).toEqual([{ ...window("r1~own"), runner: "r1" }]);
        expect(await runnerDesktops(deps)).toEqual([{ runner: "r1", state: { running: true, windows: 2 } }]);
    });

    test("are closed and opened on their runner by the merged name, and a local name is left alone", async () => {
        const asked: object[] = [];
        const deps = {
            logger: quiet,
            runners: storeOf("r1"),
            runnerHub: hubOf({
                r1: {
                    closeBrowser: noting(asked, { ok: true }),
                    openBrowser: async () => ({ name: "_own", pageId: "p1" }),
                },
            }),
        };
        expect(await runnerWindowOf(deps, "mcp-local")).toBeUndefined();
        expect(await runnerWindowOf(deps, "stranger~own")).toBeUndefined();
        expect(await closeRunnerBrowser(deps, "mcp-local")).toBe(false);
        expect(await closeRunnerBrowser(deps, "r1~own")).toBe(true);
        expect(asked).toEqual([{ name: "own" }]);
        expect(await openRunnerBrowser(deps, "r1", "https://example.test")).toEqual({ name: "r1~_own", pageId: "p1" });
        expect(await failureOf(openRunnerBrowser(deps, "nobody", undefined))).toMatchObject({ code: "NOT_FOUND" });
    });

    test("have a tab's menu and the strip's drag carried to their runner, never acted on here", async () => {
        const asked: object[] = [];
        const deps = {
            logger: quiet,
            runners: storeOf("r1"),
            runnerHub: hubOf({ r1: { browserTab: noting(asked, { name: "own", pageId: "p2" }) }, old: { browserTab: notFound } }),
        };
        // A local window's name is this sandbox's to act on.
        expect(await runnerBrowserTab(deps, { op: "move", name: "mcp-local", pageId: "p1", index: 0 })).toBeUndefined();
        expect(await runnerBrowserTab(deps, { op: "action", name: "r1~own", pageId: "p1", action: "duplicate" })).toEqual({ name: "r1~own", pageId: "p2" });
        expect(await runnerBrowserTab(deps, { op: "reopen", name: "r1~own" })).toEqual({ name: "r1~own", pageId: "p2" });
        expect(asked).toEqual([
            { op: "action", name: "own", pageId: "p1", action: "duplicate" },
            { op: "reopen", name: "own" },
        ]);
        // An older runner is told plainly, not silently passed over.
        const older = { ...deps, runners: storeOf("old") };
        expect(await failureOf(runnerBrowserTab(older, { op: "reopen", name: "old~own" }))).toMatchObject({ code: "PRECONDITION_FAILED" });
    });
});

describe("a runner port's preview", () => {
    const placedOnR1 = new Map([placed("c1", "r1")].map((entry) => [entry.id, entry]));
    const servicesWith = (doors: Doors | undefined, runner = "r1", agents = [{ id: "c1", runner: "r1" }]) => {
        const forwarded: string[] = [];
        const services = {
            auth: {},
            agents: { list: () => agents, entry: (id: string) => placedOnR1.get(id) },
            runners: storeOf(runner),
            runnerHub: hubOf(doors === undefined ? {} : { r1: doors }),
            portForwards: {
                forwardRunner: (on: string, port: number) => {
                    forwarded.push(`${on}:${port}`);
                    return "a1b2";
                },
            },
        };
        return { services, forwarded };
    };
    const urlOf = (slot: string) => `https://port-${slot}-sbx.example.test`;

    const maintainer: Caller = { email: "m@example.test", tier: "maintainer" };

    test("is minted once the runner says the port may be previewed", async () => {
        const { services, forwarded } = servicesWith({ vetPort: async () => ({}) });
        expect(await forwardRunnerPort(services, maintainer, "r1", 5173, urlOf)).toEqual({ previewUrl: "https://port-a1b2-sbx.example.test" });
        expect(forwarded).toEqual(["r1:5173"]);
    });

    test("is a maintainer's who may read a conversation that runs on that runner, asked before the runner is", async () => {
        const asked: object[] = [];
        const { services, forwarded } = servicesWith({ vetPort: noting(asked, {}) });
        for (const identity of [undefined, { email: "w@example.test", tier: "writer" as const }]) {
            expect(await failureOf(forwardRunnerPort(services, identity, "r1", 5173, urlOf))).toMatchObject({ code: "FORBIDDEN" });
        }
        // No conversation runs there, so there is nothing of the runner's a person here is entitled to.
        const empty = servicesWith({ vetPort: noting(asked, {}) }, "r1", []);
        expect(await failureOf(forwardRunnerPort(empty.services, maintainer, "r1", 5173, urlOf))).toMatchObject({ code: "FORBIDDEN" });
        expect(asked).toEqual([]);
        expect(forwarded).toEqual([]);
    });

    test("is refused with the runner's reason, nothing minted; and said plainly for an older, away or unknown runner", async () => {
        const refused = servicesWith({ vetPort: async () => ({ refused: "port 9222 is a browser's DevTools port" }) });
        const failure = await failureOf(forwardRunnerPort(refused.services, maintainer, "r1", 9222, urlOf));
        expect(failure).toMatchObject({ code: "BAD_REQUEST" });
        expect(failure.message).toContain("DevTools");
        expect(refused.forwarded).toEqual([]);
        expect(await failureOf(forwardRunnerPort(servicesWith({ vetPort: notFound }).services, maintainer, "r1", 1, urlOf))).toMatchObject({
            code: "PRECONDITION_FAILED",
        });
        expect(await failureOf(forwardRunnerPort(servicesWith(undefined).services, maintainer, "r1", 1, urlOf))).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
        expect(await failureOf(forwardRunnerPort(servicesWith(undefined, "r9").services, maintainer, "r1", 1, urlOf))).toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("runners.openView", () => {
    const maintainer: Caller = { email: "m@example.test", tier: "maintainer" };
    const viewer: Caller = { email: "v@example.test", tier: "viewer" };
    const entries = new Map([placed("c1", "r1"), placed("local", undefined)].map((entry) => [entry.id, entry]));
    const services = (online: boolean) => ({
        auth: {},
        agents: { entry: (id: string) => entries.get(id) },
        runnerHub: hubOf(online ? { r1: {} } : {}),
    });

    test("answers the runner view's path and a one-shot ticket the parent's netd redeems", () => {
        const tickets = createRunnerViewTickets();
        const view = openRunnerView(services(true), { identity: maintainer }, { conversationId: "c1", kind: "terminal", session: "job-j1" }, tickets);
        expect(view.runner).toBe("r1");
        expect(view.path).toBe("/system/runner-view/r1/system/terminal");
        expect(view.query).toMatch(/^session=job-j1&ticket=/);
        expect(tickets.redeem({ runner: "r1", path: "/system/terminal", query: view.query })).toMatchObject({ allowed: true });
    });

    test("refuses a conversation that runs here, a person below maintainer, a runner that is away and an unknown id", () => {
        const tickets = createRunnerViewTickets();
        const open =
            (identity: Caller, conversationId: string, online = true) =>
            () =>
                openRunnerView(services(online), { identity }, { conversationId, kind: "browser-view", session: "s1" }, tickets);
        expect(open(maintainer, "local")).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
        expect(open(viewer, "c1")).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
        expect(open(maintainer, "c1", false)).toThrow(expect.objectContaining({ code: "SERVICE_UNAVAILABLE" }));
        expect(open(maintainer, "nobody")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    });
});

test("a revocation reaches every connected runner, naming the member, an older one skipped quietly", async () => {
    const told: object[] = [];
    const warned: string[] = [];
    await tellRunnersRevoked(
        {
            runners: storeOf("r1", "old", "asleep"),
            runnerHub: hubOf({ r1: { revoke: noting(told, { ok: true }) }, old: { revoke: notFound } }),
        },
        "Leaver@Example.test",
        (runner) => warned.push(runner),
    );
    expect(told).toEqual([{ member: "Leaver@Example.test" }]);
    expect(warned).toEqual([]);
});
