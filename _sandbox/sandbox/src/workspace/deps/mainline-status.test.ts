import type { MainlineRun } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import type { DependencyLandOrigin } from "./dependency-origin.js";
import * as verifyDeps from "./verify-deps.js";
import type { VerifyQueueSnapshot } from "./verify-deps.js";
import type { VerifyOutcome } from "./verify-store.js";

// The main-line check as the editor reads it: what the verify store remembers, and what the queue holds right now. The
// queue is the check's own module state, so it is stood in for here; how it fills is verify-deps.integration.test.ts's.

let snapshot: VerifyQueueSnapshot = { current: undefined, pending: [] };
jest.mock("./verify-deps.js", () => ({ ...verifyDeps, verifyQueueSnapshot: () => snapshot }));
const { knownReds, mainlineStatus } = await import("./mainline-status.js");

afterEach(() => {
    snapshot = { current: undefined, pending: [] };
});

const storeOf = (projects: Record<string, VerifyOutcome>, runs: readonly MainlineRun[]): Pick<Services, "verifyStore"> => ({
    verifyStore: unstubbed<Services["verifyStore"]>("verifyStore", { read: async () => ({ projects, runs }) }),
});

const land = (agentId: string, title?: string): DependencyLandOrigin => ({
    kind: "land",
    agentId,
    ...(title === undefined ? {} : { title }),
    branch: `agent/${agentId}`,
    repos: [{ repo: "root", from: "abc", dir: "" }],
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
        expect(await mainlineStatus(storeOf({}, []))).toEqual({ projects: [], recent: [] });
    });

    test("joins what the store remembers to what runs and waits now, one row per project in folder order", async () => {
        const appRed = run({ project: "app", at: 9, failures: ["x"], failureCount: 1, attempt: 2 });
        const libGreen = run({ project: "lib", at: 8, status: "green", attempt: 0 });
        const appEarlier = run({ project: "app", at: 3, attempt: 1 });
        snapshot = {
            current: { dir: "web", command: "pnpm test", startedAt: 100, lands: [land("a", "Ship the page")] },
            pending: [
                { dirs: ["app"], lands: [land("b")] },
                // A causeless install waits too, but answers for no land.
                { dirs: ["web", "lib"], lands: [] },
            ],
        };
        const projects: Record<string, VerifyOutcome> = {
            lib: { status: "green", attempt: 0, at: 8 },
            app: { status: "red", attempt: 2, at: 9, failures: ["x"], since: 3 },
        };

        expect(await mainlineStatus(storeOf(projects, [appRed, libGreen, appEarlier]))).toEqual({
            projects: [
                { project: "app", queued: [{ conversationId: "b", at: 0 }], last: appRed, redSince: 3 },
                { project: "lib", queued: [], last: libGreen },
                {
                    project: "web",
                    running: { command: "pnpm test", startedAt: 100, lands: [{ conversationId: "a", title: "Ship the page", at: 0 }] },
                    queued: [],
                },
            ],
            recent: [appRed, libGreen, appEarlier],
        });
    });

    // A red recorded before streaks were kept names no start; the red it has is the earliest the store can vouch for.
    test("dates a red streak the store never started from the red it holds", async () => {
        const status = await mainlineStatus(storeOf({ "": { status: "red", attempt: 1, at: 7 } }, []));

        expect(status.projects).toEqual([{ project: "", queued: [], redSince: 7 }]);
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
