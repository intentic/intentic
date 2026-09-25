import type { MainlineRun } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { knownReds, mainlineStatus } from "./mainline-status.js";
import type { StoredPush } from "./push-checks-store.js";
import type { CurrentRun } from "./verify-deps.js";
import type { QueuedLand, Streak, VerifyOutcome } from "./verify-store.js";

// The main-line check as the editor reads it: what the verify store remembers and holds waiting, and what the land check
// runs right now. How the queue fills is verify-deps.integration.test.ts's.

const storeOf = (
    projects: Record<string, VerifyOutcome>,
    runs: readonly MainlineRun[],
    pushes: readonly StoredPush[] = [],
    waiting: { readonly current?: CurrentRun; readonly lands?: Record<string, readonly QueuedLand[]>; readonly streaks?: Record<string, Streak> } = {},
): Pick<Services, "verifyStore" | "pushChecks" | "landCheck"> => ({
    verifyStore: unstubbed<Services["verifyStore"]>("verifyStore", { read: async () => ({ projects, runs }),
        lands: async () => waiting.lands ?? {},
        streaks: async () => waiting.streaks ?? {},
    }),
    pushChecks: unstubbed<Services["pushChecks"]>("pushChecks", {
        store: unstubbed<Services["pushChecks"]["store"]>("pushChecks.store", { read: async () => ({ pushes: [...pushes], seen: [] }) }),
    }),
    landCheck: unstubbed<Services["landCheck"]>("landCheck", { current: () => waiting.current }),
});

const land = (agentId: string, at: number, title?: string): QueuedLand => ({
    kind: "land",
    agentId,
    ...(title === undefined ? {} : { title }),
    branch: `agent/${agentId}`,
    repos: [{ repo: "root", from: "abc", dir: "" }],
    at,
});

const run = (over: Partial<MainlineRun> & Pick<MainlineRun, "project" | "at">): MainlineRun => ({
    command: "pnpm verify",
    status: "red",
    startedAt: over.at - 10,
    lands: [],
    failures: [],
    failureCount: 0,
    attempt: 1,
    ...over,
});

describe("the main line's status", () => {
    test("is empty before anything was checked or queued", async () => {
        expect(await mainlineStatus(storeOf({}, []))).toEqual({ projects: [], recent: [], pushes: [] });
    });

    test("joins what the store remembers to what runs and waits now, one row per project in folder order", async () => {
        const appRed = run({ project: "app", at: 9, failures: ["x"], failureCount: 1, attempt: 2 });
        const libGreen = run({ project: "lib", at: 8, status: "green", attempt: 0 });
        const appEarlier = run({ project: "app", at: 3, attempt: 1 });
        const running = land("a", 50, "Ship the page");
        const waiting = {
            current: { dir: "web", command: "pnpm test", startedAt: 100, lands: [running], session: "web--verify" },
            // The land the running check covers waits in the store until its verdict answers it; only the rest are queued.
            lands: { app: [land("b", 60)], web: [running] },
        };
        const projects: Record<string, VerifyOutcome> = {
            lib: { status: "green", attempt: 0, at: 8 },
            app: { status: "red", attempt: 2, at: 9, failures: ["x"], since: 3 },
        };

        const appRedServed = { ...appRed, units: [{ name: "x" }] };
        expect(await mainlineStatus(storeOf(projects, [appRed, libGreen, appEarlier], [], waiting))).toEqual({
            projects: [
                {
                    project: "app",
                    queued: [{ conversationId: "b", at: 60 }],
                    session: "panel-app--verify",
                    last: appRedServed,
                    redSince: 3,
                    red: { since: 3, cause: [], named: false },
                },
                { project: "lib", queued: [], session: "panel-lib--verify", last: libGreen },
                {
                    project: "web",
                    running: { command: "pnpm test", startedAt: 100, lands: [{ conversationId: "a", title: "Ship the page", at: 50 }] },
                    queued: [],
                    session: "panel-web--verify",
                },
            ],
            recent: [appRedServed, libGreen, appEarlier],
            pushes: [],
        });
    });

    // The key a later measurement names a finding by is the store's own; the editor reads the finding without it.
    test("serves what each push check let through, newest first, without the keys the store files findings by", async () => {
        const push = (id: string, at: number): StoredPush => ({
            project: "app",
            id,
            at,
            remote: "origin",
            branch: "main",
            base: "b0",
            head: `h${at}`,
            commits: 1,
            findings: [
                { id: `check:paths:${id}`, kind: "check", check: "paths", gate: "code", text: `a.ts: ${id}`, state: "open", key: `a.ts:${id}` },
            ],
        });

        const status = await mainlineStatus(storeOf({}, [], [push("r2", 20), push("r1", 10)]));

        expect(status.pushes).toEqual([
            {
                project: "app",
                id: "r2",
                at: 20,
                remote: "origin",
                branch: "main",
                base: "b0",
                head: "h20",
                commits: 1,
                findings: [{ id: "check:paths:r2", kind: "check", check: "paths", gate: "code", text: "a.ts: r2", state: "open" }],
            },
            {
                project: "app",
                id: "r1",
                at: 10,
                remote: "origin",
                branch: "main",
                base: "b0",
                head: "h10",
                commits: 1,
                findings: [{ id: "check:paths:r1", kind: "check", check: "paths", gate: "code", text: "a.ts: r1", state: "open" }],
            },
        ]);
    });

    // A red recorded before streaks were kept names no start; the red it has is the earliest the store can vouch for.
    test("dates a red streak the store never started from the red it holds", async () => {
        const status = await mainlineStatus(storeOf({ "": { status: "red", attempt: 1, at: 7 } }, []));

        expect(status.projects).toEqual([{ project: "", queued: [], session: "panel-root--verify", redSince: 7, red: { since: 7, cause: [], named: false } }]);
    });

    // The router files who a run's failures are laid at as the run settles; the status serves that one answer.
    test("lays a red streak at the latest run that named anybody, with the latest decision about it", async () => {
        const sent = { kind: "original" as const, conversationId: "c-1", at: 31, detail: "Sent back." };
        const runs = [
            // Found main red: nothing new failed in it, so it names nobody.
            run({ project: "app", at: 40, lands: [{ conversationId: "c-2", at: 39 }], named: false }),
            run({ project: "app", at: 30, lands: [{ conversationId: "c-1", title: "Fix the parser", at: 29 }], suspects: ["c-1"], named: true, routing: sent }),
        ];

        const status = await mainlineStatus(storeOf({ app: { status: "red", attempt: 2, at: 40, since: 30 } }, runs));

        expect(status.projects[0]?.red).toEqual({ since: 30, cause: [{ conversationId: "c-1", title: "Fix the parser" }], named: true, fixer: sent });
    });

    // The streak's Red is the router's own record of the red: what it holds is the answer, whatever the runs say.
    test("lays a red streak at what its Red holds, with its latest decision, over what the runs were filed with", async () => {
        const sent = { kind: "original" as const, conversationId: "c-2", at: 41 };
        const runs = [run({ project: "app", at: 30, lands: [{ conversationId: "c-2", title: "Fix the lexer", at: 29 }], suspects: ["c-1"], named: true })];
        const red: Streak = { since: 30, findings: [], suspects: ["c-2"], named: false, decisions: [{ kind: "waiting", at: 31 }, sent], told: [] };

        const status = await mainlineStatus(storeOf({ app: { status: "red", attempt: 1, at: 30, since: 30 } }, runs, [], { streaks: { app: red } }));

        expect(status.projects[0]?.red).toEqual({ since: 30, cause: [{ conversationId: "c-2", title: "Fix the lexer" }], named: false, fixer: sent });
    });

    test("names every land a run covered as the cause, unnarrowed, when blame could not tell them apart", async () => {
        const runs = [
            run({
                project: "app",
                at: 30,
                lands: [
                    { conversationId: "c-1", at: 28 },
                    { conversationId: "c-2", at: 29 },
                ],
                suspects: ["c-1", "c-2"],
                named: false,
            }),
        ];

        const status = await mainlineStatus(storeOf({ app: { status: "red", attempt: 1, at: 30, since: 30 } }, runs));

        expect(status.projects[0]?.red).toEqual({ since: 30, cause: [{ conversationId: "c-1" }, { conversationId: "c-2" }], named: false });
    });

    test("serves each failure split into the name a reader scans and the path it failed in", async () => {
        const status = await mainlineStatus(storeOf({}, [run({ project: "app", at: 5, failures: ["@a/web#test src/x.test.ts › renders"] })]));

        expect(status.recent[0]?.units).toEqual([{ name: "renders", path: "src/x.test.ts" }]);
    });
});

describe("the reds a turn is told of", () => {
    test("are the red projects alone, in folder order, each with its latest red run's failures and the lands it answered for", async () => {
        const projects: Record<string, VerifyOutcome> = {
            web: { status: "red", attempt: 1, at: 20, failures: ["w"], since: 20 },
            app: { status: "red", attempt: 3, at: 30, failures: ["a", "b", "c"], since: 10 },
            lib: { status: "green", attempt: 0, at: 25 },
        };
        const runs = [
            run({ project: "app", at: 31, status: "green", attempt: 0 }),
            run({
                project: "app",
                at: 30,
                failures: ["a", "b"],
                failureCount: 3,
                lands: [{ conversationId: "c-1", title: "Fix the parser", at: 29 }],
            }),
            run({ project: "web", at: 20, failures: ["w"], failureCount: 1, lands: [{ conversationId: "c-2", at: 19 }] }),
        ];

        expect(await knownReds(storeOf(projects, runs))).toEqual([
            { project: "app", since: 10, failures: ["a", "b"], failureCount: 3, lands: ["Fix the parser"] },
            { project: "web", since: 20, failures: ["w"], failureCount: 1, lands: ["c-2"] },
        ]);
    });

    // The history keeps forty runs across every project; an old red can outlive its run and still be told of.
    test("fall back to the verdict's own failures when the run that named them has aged out of the history", async () => {
        const failures = Array.from({ length: 35 }, (_, index) => `unit-${index}`);

        const [red] = await knownReds(storeOf({ app: { status: "red", attempt: 5, at: 50, failures } }, []));

        expect(red).toEqual({ project: "app", since: 50, failures: failures.slice(0, 30), failureCount: 35, lands: [] });
    });
});
