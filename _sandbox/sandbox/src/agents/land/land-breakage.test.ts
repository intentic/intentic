import {
    type ActivityEvent,
    type AgentSummary,
    fixAttemptId,
    LAND_FIX_OPENING,
    landBreakagePrompt,
    landFixConversationId,
    type MainlineRouting,
    SandboxSettingsSchema,
} from "@intentic/sandbox-contract";
import type { GitRunner } from "@intentic/scaffold";
import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync, realSleep, waitFor } from "@intentic/testing/bun";
import type { Services } from "../../composition.js";
import { recordingLogger } from "../../harness/route-fakes.testing.js";
import type { Said, SentTurn } from "../../seams/turn-starter.js";
import { isolatedAgent, memoryVerifyStore } from "../../testing.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import { type LandBreakage, mainlineLandOf } from "../../workspace/deps/verify-deps.js";
import type { QueuedLand } from "../../workspace/deps/verify-store.js";
import { narrowCheckOf } from "./land-fix.js";

// What a red main-line check is owed, decided from the fleet as it stands: wait for the check behind it, hold while a
// conversation still works on what failed, send it back to the land it came with while that conversation still has the
// work in mind, else a fresh conversation, and past a streak's allowance, a person. Which land the units name is read off
// the units the land verify reports (failure-units.mjs, land-tiers.mjs).

// A conversation's unlanded paths are real git (landing-paths.ts, with its own suite); here they are the answer a case
// sets.
const unlanded = new Map<string, readonly string[]>();
jest.mock("./landing-paths.js", () => ({
    landingPaths: async (_services: unknown, agent: { readonly id: string }) => unlanded.get(agent.id) ?? [],
}));
const {
    breakageRunSettled,
    breakageSettled,
    failingPackages,
    packageOf,
    pathOfUnit,
    resetBreakageRouter,
    resumeBreakageRouter,
    routeLandBreakage,
    stillInMind,
    suspectsOf,
} = await import("./land-breakage.js");

beforeEach(() => {
    resetBreakageRouter();
    unlanded.clear();
});

afterEach(() => {
    jest.useRealTimers();
});

const land = (agentId: string): DependencyLandOrigin => ({
    kind: "land",
    agentId,
    branch: `agent/${agentId}`,
    repos: [{ repo: "intentic", from: "abc", dir: "" }],
});

test("every unit shape names the path it failed on", () => {
    expect(pathOfUnit("@intentic/web#test _editor/web/src/a.test.ts › outer > it")).toBe("_editor/web/src/a.test.ts");
    expect(pathOfUnit("@intentic/sandbox#typecheck _sandbox/sandbox/src/a.ts: TS2322 Type 'x'")).toBe("_sandbox/sandbox/src/a.ts");
    expect(pathOfUnit("lint _site/site/src/Footer.astro: import(no-duplicates) Duplicate")).toBe("_site/site/src/Footer.astro");
    expect(pathOfUnit("tidy layout: - _devices/machine: 3 colliding basename(s)")).toBe("_devices/machine");
    expect(pathOfUnit("rustfmt _sandbox/ic")).toBe("_sandbox/ic");
    expect(pathOfUnit("@intentic/web#test")).toBeUndefined();
    expect(packageOf("_editor/web/src/a.ts")).toBe("_editor/web");
});

test("the packages failures sit in are the ones their paths name, once each, and none for a unit that names no path", () => {
    expect(
        [
            ...failingPackages([
                "@intentic/sandbox#test _sandbox/sandbox/src/a.test.ts › x",
                "@intentic/sandbox#typecheck _sandbox/sandbox/src/b.ts: TS2322",
                "lint _site/site/src/Footer.astro: r m",
                "@intentic/web#test",
            ]),
        ].toSorted(),
    ).toEqual(["_sandbox/sandbox", "_site/site"]);
    expect(failingPackages(["@intentic/web#test"]).size).toBe(0);
});

test("of several lands, the one whose changes share a package with a failure is the one named", () => {
    const one = land("one");
    const two = land("two");
    const lands = [
        { land: one, paths: ["_editor/web/src/b.ts"] },
        { land: two, paths: ["_sandbox/sandbox/src/c.ts"] },
    ];
    expect(suspectsOf(["@intentic/sandbox#test _sandbox/sandbox/src/c.test.ts › x"], lands)).toEqual([two]);
    expect(suspectsOf(["lint _tools/x.mjs: r m"], lands)).toEqual([]);
    expect(suspectsOf(["@intentic/sandbox#test"], lands)).toEqual([one, two]);
    // Both touching the failing package: blame by paths alone cannot tell them apart.
    expect(
        suspectsOf(["@intentic/sandbox#test _sandbox/sandbox/src/c.test.ts › x"], [...lands, { land: one, paths: ["_sandbox/sandbox/src/d.ts"] }]),
    ).toEqual([two, one]);
});

describe("whether a conversation still has the work in mind", () => {
    const NOW = 10_000_000;
    const reading = (over: Partial<Pick<AgentSummary, "promptCache" | "contextTokens" | "contextWindow" | "updatedAt">>) => ({
        updatedAt: 0,
        ...over,
    });

    test.each([
        [
            "its prompt cache is warm and its window roomy",
            reading({ promptCache: { at: NOW - 1_000, ttlMs: 300_000 }, contextTokens: 20_000, contextWindow: 200_000 }),
            true,
        ],
        ["its prompt cache has expired", reading({ promptCache: { at: NOW - 300_000, ttlMs: 300_000 } }), false],
        ["the date in its prompt has rolled since", reading({ promptCache: { at: NOW - 1_000, ttlMs: 3_600_000, rollsAt: NOW } }), false],
        ["the date in its prompt rolls only later", reading({ promptCache: { at: NOW - 1_000, ttlMs: 3_600_000, rollsAt: NOW + 1 } }), true],
        [
            "it is warm but past three fifths of its window",
            reading({ promptCache: { at: NOW - 1_000, ttlMs: 300_000 }, contextTokens: 120_000, contextWindow: 200_000 }),
            false,
        ],
        [
            "it is warm just under three fifths of its window",
            reading({ promptCache: { at: NOW - 1_000, ttlMs: 300_000 }, contextTokens: 119_999, contextWindow: 200_000 }),
            true,
        ],
        ["it publishes no cache deadline but was active in the last five minutes", reading({ updatedAt: NOW - 299_999 }), true],
        ["it publishes no cache deadline and was last active five minutes ago", reading({ updatedAt: NOW - 300_000 }), false],
        ["it names no window, which is not the same as a full one", reading({ updatedAt: NOW - 1_000, contextTokens: 190_000 }), true],
    ] as const)("%s", (_case, agent, inMind) => {
        expect(stillInMind(agent, NOW)).toBe(inMind);
    });

    test("an agent the roster no longer has is not", () => {
        expect(stillInMind(undefined, NOW)).toBe(false);
    });
});

/* ROUTING. The fleet below is what the router reads (the roster, the records, who is running) and every door it knocks
   on, recorded: what it said to a conversation, which fix-up it started, what it filed on which run, and its activity. */

const SANDBOX_TEST = "@intentic/sandbox#test _sandbox/sandbox/src/parser.test.ts › parses a heading";
const SANDBOX_LEXER = "@intentic/sandbox#test _sandbox/sandbox/src/lexer.test.ts › tokenizes";
const SANDBOX_TYPES = "@intentic/sandbox#typecheck _sandbox/sandbox/src/turn.ts: TS2322 Type 'x'";

// A land into the workspace root, the way a conversation's isolated turn lands it and the check files it.
const origin = (agentId: string): QueuedLand => ({
    kind: "land",
    agentId,
    title: `Work ${agentId}`,
    branch: `agent/${agentId}`,
    repos: [{ repo: "root", from: `from-${agentId}`, dir: "" }],
    at: 500,
});

const red = (over: Partial<LandBreakage> = {}): LandBreakage => ({
    project: "",
    command: "pnpm verify",
    lands: [origin("one")],
    fresh: [SANDBOX_TEST],
    failures: [SANDBOX_TEST],
    logTail: "\n1 failed\n",
    runAt: 1_000,
    redSince: 1_000,
    queuedBehind: false,
    measured: true,
    ...over,
});

// The follow-up a conversation is sent for failures that arrived with its land.
const followUp = (units: readonly string[]): string =>
    landBreakagePrompt([
        "`pnpm verify` in the workspace root failed on:",
        units.map((unit) => `- ${unit}`).join("\n"),
        narrowCheckOf("pnpm verify"),
        "The end of its output:\n\n```\n1 failed\n```",
    ]);

interface Conversation {
    readonly id: string;
    // Warm in the prompt cache with room to spare; cold is an hour past its cache's life.
    readonly warm?: boolean;
    readonly running?: boolean;
    readonly archived?: boolean;
    // The tip its land recorded; with one, what the land changed is read through the router's git.
    readonly tip?: string;
}

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

const fleet = (conversations: readonly Conversation[], options: { readonly autoRepair?: boolean } = {}) => {
    const now = Date.now();
    const running = new Set(conversations.filter((conversation) => conversation.running === true).map(({ id }) => id));
    const entries = new Map(
        conversations.map((conversation) => [
            conversation.id,
            isolatedAgent(
                [{ repo: "root", base: `from-${conversation.id}`, ...(conversation.tip === undefined ? {} : { landedTip: conversation.tip }) }],
                {
                    id: conversation.id,
                    ...(conversation.archived === true ? { archivedAt: now } : {}),
                },
            ),
        ]),
    );
    const cards = new Map(
        conversations.map((conversation): [string, AgentSummary] => [
            conversation.id,
            {
                id: conversation.id,
                status: conversation.running === true ? "running" : "idle",
                provider: "claude",
                harness: "native",
                attention: { ...NO_ATTENTION },
                updatedAt: now,
                promptCache: conversation.warm === false ? { at: now - 7_200_000, ttlMs: 3_600_000 } : { at: now, ttlMs: 3_600_000 },
                ...(conversation.archived === true ? { archivedAt: now } : {}),
            },
        ]),
    );
    const said: Said[] = [];
    const started: SentTurn[] = [];
    const filed: {
        readonly project: string;
        readonly at: number;
        readonly routing: MainlineRouting;
        readonly suspects?: readonly string[] | undefined;
    }[] = [];
    const activity: Omit<ActivityEvent, "id" | "at">[] = [];
    const { lines, logger } = recordingLogger();
    // The verify store as the daemon keeps it, with every routing the router files recorded on the way in.
    const store = memoryVerifyStore();
    const verifyStore: Services["verifyStore"] = {
        ...store,
        routed: async (project, at, routing, suspects) => {
            filed.push({ project, at, routing, suspects });
            await store.routed(project, at, routing, suspects);
        },
    };
    // Whether a check that answers for some land is ahead of the red being decided.
    const ahead = { value: false };
    const services = unstubbed<Services>("services", {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({ autoRepair: options.autoRepair ?? true }),
        }),
        agents: unstubbed<Services["agents"]>("agents", {
            entry: (id) => entries.get(id),
            get: (id) => cards.get(id),
            list: () => [...cards.values()],
            listArchived: () => [],
        }),
        conversations: unstubbed<Services["conversations"]>("conversations", {
            running: (id) => running.has(id),
            sessionIdOf: () => undefined,
            state: () => undefined,
        }),
        turns: unstubbed<Services["turns"]>("turns", {
            say: async (words) => {
                said.push(words);
                return { delivered: "started", run: `run-${said.length}` };
            },
            start: async (turn) => {
                started.push(turn);
                return { id: `fix-${started.length}`, async *frames() {} };
            },
        }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { mainDir: (repo) => (repo === "root" ? "/w" : `/w/${repo}`) }),
        activity: unstubbed<Services["activity"]>("activity", {
            append: async (event) => {
                activity.push(event);
            },
        }),
        logger,
        verifyStore,
        landCheck: unstubbed<Services["landCheck"]>("landCheck", { ahead: async () => ahead.value }),
    });
    // Who each thing the router said was said to, and what, in order.
    const told = (): { readonly to: string; readonly prompt: string }[] => said.map(({ turn }) => ({ to: turn.conversationId, prompt: turn.prompt }));
    const types = (): string[] => activity.map(({ type }) => type);
    return { services, running, told, started, filed, types, activity, lines, ahead };
};

type World = ReturnType<typeof fleet>;

// A red run as the land check hands it over: filed in the history first, then routed.
const route = async (world: World, breakage: LandBreakage, git?: GitRunner): Promise<MainlineRouting | undefined> => {
    await world.services.verifyStore.noteRun({
        project: breakage.project,
        command: breakage.command,
        status: "red",
        startedAt: breakage.runAt - 10,
        at: breakage.runAt,
        lands: breakage.lands.map(mainlineLandOf),
        failures: [...breakage.failures],
        failureCount: breakage.failures.length,
        attempt: 1,
    });
    return routeLandBreakage(world.services, breakage, git);
};

// The router's git answers `diff --name-only` for a land by the tip it names; any other question is a failure here.
const changedBy =
    (paths: Readonly<Record<string, readonly string[]>>): GitRunner =>
    async (_dir, args) => {
        const tip = args[4] ?? "";
        if (args[0] !== "diff" || paths[tip] === undefined) {
            throw new Error(`unexpected git ${args.join(" ")}`);
        }
        return { stdout: paths[tip].join("\n"), stderr: "" };
    };

const routed = (kind: MainlineRouting["kind"], over: Partial<MainlineRouting> = {}): MainlineRouting => ({ kind, at: expect.any(Number), ...over });

// What the router decided, for a case in which it must decide something.
const decided = async (pending: Promise<MainlineRouting | undefined>): Promise<MainlineRouting> => {
    const routing = await pending;
    if (routing === undefined) {
        throw new Error("the router owed this red nothing");
    }
    return routing;
};

describe("a red with nothing owed", () => {
    test("owes nothing when nothing new failed and nothing was carried in, or no land is there to answer for it", async () => {
        const world = fleet([{ id: "one" }]);

        expect(await route(world, red({ fresh: [] }))).toBeUndefined();
        expect(await route(world, red({ lands: [], runAt: 2_000 }))).toBeUndefined();
        expect(world.told()).toEqual([]);
        expect(world.started).toEqual([]);
        expect(world.filed).toEqual([]);
    });

    test("is only reported while repairs after landing are switched off", async () => {
        const world = fleet([{ id: "one" }], { autoRepair: false });

        expect(await route(world, red())).toEqual(routed("reported", { detail: "Repairs after landing are switched off." }));
        expect(world.told()).toEqual([]);
        expect(world.started).toEqual([]);
        // The run just settled is filed by the check that asked; nothing was carried in to file with it.
        expect(world.filed).toEqual([]);
    });
});

describe("the conversation that landed it", () => {
    test("is sent the failures back while it still has the work in mind, and the decision is filed on the run", async () => {
        const world = fleet([{ id: "one" }]);

        const routing = await decided(route(world, red()));

        expect(routing).toEqual(routed("original", { conversationId: "one", detail: "Sent back to the conversation that landed it (1 of 2)." }));
        expect(world.told()).toEqual([{ to: "one", prompt: followUp([SANDBOX_TEST]) }]);
        expect(world.started).toEqual([]);
        expect(world.filed).toEqual([{ project: "", at: 1_000, routing, suspects: ["one"] }]);
        expect(world.activity).toEqual([
            {
                direction: "system",
                type: "deps.breakage_routed",
                content: "1 failure(s) appeared with this land; sent back to it to fix (1 of 2).",
                outcome: "ok",
                conversationId: "one",
                title: "Work one",
            },
        ]);
    });

    // Past two follow-ups the breakage is not that conversation's to keep chasing; somebody fresh takes it.
    test("is sent at most two follow-ups a red streak, and the third goes to a fresh conversation", async () => {
        const world = fleet([{ id: "one" }]);

        const kinds = [
            (await route(world, red()))?.kind,
            (await route(world, red({ runAt: 2_000, fresh: [SANDBOX_LEXER], failures: [SANDBOX_TEST, SANDBOX_LEXER] })))?.kind,
        ];
        const third = await route(world, red({ runAt: 3_000, fresh: [SANDBOX_TYPES], failures: [SANDBOX_TYPES] }));

        expect(kinds).toEqual(["original", "original"]);
        expect(world.told().map(({ to }) => to)).toEqual(["one", "one"]);
        expect(third).toEqual(
            routed("fix-up", {
                conversationId: landFixConversationId("", 1_000),
                detail: 'The conversation that landed it ("Work one") was already sent it 2 times.',
            }),
        );
        expect(world.started.map(({ conversationId }) => conversationId)).toEqual([landFixConversationId("", 1_000)]);
    });

    test("is sent nothing once it has gone cold, and a fresh conversation is handed the failures instead", async () => {
        const world = fleet([{ id: "one", warm: false }]);

        const routing = await decided(route(world, red()));

        const passedOver =
            'The conversation that landed it ("Work one") has gone cold or is nearly full, so reading all of it again would cost more than starting fresh.';
        expect(routing).toEqual(routed("fix-up", { conversationId: landFixConversationId("", 1_000), detail: passedOver }));
        expect(world.told()).toEqual([]);
        expect(world.started).toEqual([
            {
                isolated: true,
                runRole: "pipeline-fix",
                prompt: expect.stringContaining(passedOver),
                title: 'Fix main after "Work one"',
                conversationId: landFixConversationId("", 1_000),
                byPerson: false,
            },
        ]);
        expect(world.started[0]?.prompt.startsWith(LAND_FIX_OPENING)).toBe(true);
        expect(world.filed).toEqual([{ project: "", at: 1_000, routing, suspects: ["one"] }]);
        expect(world.types()).toEqual(["deps.breakage_fixup"]);
    });

    test("is sent nothing once archived", async () => {
        const world = fleet([{ id: "one", archived: true }]);

        expect(await route(world, red())).toEqual(
            routed("fix-up", {
                conversationId: landFixConversationId("", 1_000),
                detail: 'The conversation that landed it ("Work one") is archived.',
            }),
        );
        expect(world.told()).toEqual([]);
    });
});

describe("blame across several lands", () => {
    const both = [
        { id: "one", tip: "tip-one" },
        { id: "two", tip: "tip-two" },
    ];

    test("names the one land whose own change touches the failing package", async () => {
        const world = fleet(both);
        const git = changedBy({ "tip-one": ["_editor/web/src/App.vue"], "tip-two": ["_sandbox/sandbox/src/parser.ts"] });

        const routing = await decided(route(world, red({ lands: [origin("one"), origin("two")] }), git));

        expect(routing).toEqual(routed("original", { conversationId: "two", detail: "Sent back to the conversation that landed it (1 of 2)." }));
        expect(world.told().map(({ to }) => to)).toEqual(["two"]);
        expect(world.filed.map(({ suspects }) => suspects)).toEqual([["two"]]);
    });

    test("hands every land to a fresh conversation when their changes cannot be told apart, re-running nothing", async () => {
        const world = fleet(both);
        const git = changedBy({ "tip-one": ["_sandbox/sandbox/src/lexer.ts"], "tip-two": ["_sandbox/sandbox/src/parser.ts"] });

        const routing = await decided(route(world, red({ lands: [origin("one"), origin("two")] }), git));

        expect(routing).toEqual(
            routed("fix-up", {
                conversationId: landFixConversationId("", 1_000),
                detail: "No single land could be named; started a fresh conversation on it.",
            }),
        );
        expect(world.told()).toEqual([]);
        expect(world.started.map(({ title }) => title)).toEqual(["Fix main: workspace"]);
        expect(world.started[0]?.prompt).toContain("No single land could be named for them; these are every land the red check covered:");
        expect(world.filed.map(({ suspects }) => suspects)).toEqual([["one", "two"]]);
    });
});

describe("a red streak's allowance of fresh conversations", () => {
    const base = landFixConversationId("", 1_000);

    // Counted as the fleet numbers the streak's attempts, archived ones included, so a restart cannot reset it.
    test("is two; past them it waits for a person", async () => {
        const world = fleet([{ id: "one", warm: false }, { id: base }, { id: fixAttemptId(base, 2) }]);

        const routing = await route(world, red());

        expect(routing).toEqual(routed("spent", { detail: "Still red after 2 fresh attempt(s); it waits for you." }));
        expect(world.started).toEqual([]);
        expect(world.types()).toEqual(["deps.breakage_spent"]);
        expect(world.filed.map(({ at, routing: filed }) => ({ at, kind: filed.kind }))).toEqual([{ at: 1_000, kind: "spent" }]);
    });

    // An attempt that ended without the fix carries on with the new failures: it is the same attempt, not a fresh one.
    test("continues the attempt already made instead of counting another", async () => {
        const world = fleet([{ id: "one", warm: false }, { id: base }]);

        const routing = await route(world, red());

        expect(routing).toEqual(routed("fix-up", { conversationId: base, detail: expect.stringContaining("has gone cold") }));
        expect(world.started.map(({ conversationId }) => conversationId)).toEqual([base]);
        expect(world.started[0]?.prompt.startsWith(LAND_FIX_OPENING)).toBe(false);
    });

    test("starts over once the project is green again, and the streak's end is logged with what it took", async () => {
        const world = fleet([{ id: "one" }]);
        await route(world, red());
        await route(world, red({ runAt: 2_000, fresh: [SANDBOX_LEXER], failures: [SANDBOX_TEST, SANDBOX_LEXER] }));

        await breakageSettled(world.services, "", undefined);
        const again = await route(world, red({ runAt: 5_000, redSince: 5_000 }));

        expect(again).toEqual(routed("original", { conversationId: "one", detail: "Sent back to the conversation that landed it (1 of 2)." }));
        expect(world.lines.filter(({ message }) => message === "mainline: red streak ended")).toEqual([
            { level: "info", message: "mainline: red streak ended", project: "", redMs: expect.any(Number), routed: 2, fixUps: 0 },
        ]);
    });
});

describe("a red with more work queued behind it", () => {
    test("waits for the check that measures that work too, and sends nobody", async () => {
        const world = fleet([{ id: "one" }]);

        expect(await route(world, red({ queuedBehind: true }))).toEqual(
            routed("waiting", { detail: "More work landed while this ran; its check decides before anybody is sent." }),
        );
        expect(world.told()).toEqual([]);
        expect(world.started).toEqual([]);
        expect(world.types()).toEqual(["deps.breakage_waiting"]);
    });

    // The next check found the carried failure still failing though it is no longer new, alongside other work's land.
    test("is routed with the next red when its failures still fail there, laid at the land they came with", async () => {
        const world = fleet([
            { id: "one", tip: "tip-one" },
            { id: "two", tip: "tip-two" },
        ]);
        const git = changedBy({ "tip-one": ["_sandbox/sandbox/src/parser.ts"], "tip-two": ["_editor/web/src/App.vue"] });
        await route(world, red({ queuedBehind: true }), git);

        const routing = await decided(
            route(world, red({ runAt: 2_000, lands: [origin("two")], fresh: [], failures: [SANDBOX_TEST] }), git),
        );

        expect(routing).toEqual(routed("original", { conversationId: "one", detail: "Sent back to the conversation that landed it (1 of 2)." }));
        expect(world.told()).toEqual([{ to: "one", prompt: followUp([SANDBOX_TEST]) }]);
        // Filed on every run it answers, the one it waited on included.
        expect(world.filed).toEqual([
            { project: "", at: 1_000, routing, suspects: ["one"] },
            { project: "", at: 2_000, routing, suspects: ["one"] },
        ]);
    });

    test("is resolved without anybody sent when the next red no longer has its failures", async () => {
        const world = fleet([{ id: "one" }, { id: "two" }]);
        await route(world, red({ queuedBehind: true }));

        expect(
            await route(world, red({ runAt: 2_000, lands: [origin("two")], fresh: [], failures: [SANDBOX_LEXER] })),
        ).toBeUndefined();
        expect(world.told()).toEqual([]);
        expect(world.filed).toEqual([
            { project: "", at: 1_000, routing: routed("resolved", { detail: "Gone at the next check, before anybody was sent." }), suspects: [] },
        ]);
    });

    // A check that crashed or timed out wrote no list: it cannot say the carried failure is gone, so it is still owed.
    test("is still owed, not resolved, when the next red names no failures at all", async () => {
        const world = fleet([{ id: "one" }, { id: "two" }]);
        await route(world, red({ queuedBehind: true }));

        const routing = await decided(
            route(world, red({ runAt: 2_000, lands: [origin("two")], fresh: [], failures: [], measured: false })),
        );

        expect(routing?.kind).not.toBe("resolved");
        expect(world.filed.map(({ at, routing: filed }) => [at, filed.kind])).toEqual([
            [1_000, routing?.kind],
            [2_000, routing?.kind],
        ]);
        expect(world.filed.some(({ routing: filed }) => filed.kind === "resolved")).toBe(false);
    });

    test("is resolved without anybody sent when the next check is green, and what follows is a new streak", async () => {
        const world = fleet([{ id: "one" }]);
        await route(world, red({ queuedBehind: true }));

        await breakageSettled(world.services, "", undefined);

        await waitFor(() =>
            expect(world.filed).toEqual([
                {
                    project: "",
                    at: 1_000,
                    routing: routed("resolved", { detail: "Green at the next check, before anybody was sent." }),
                    suspects: undefined,
                },
            ]),
        );
        expect(world.types()).toEqual(["deps.breakage_waiting", "deps.breakage_resolved"]);
        // Nothing carried: the next red answers for itself alone.
        const next = await routeLandBreakage(
            world.services,
            red({ runAt: 3_000, redSince: 3_000, fresh: [SANDBOX_LEXER], failures: [SANDBOX_LEXER] }),
        );
        expect(next?.kind).toBe("original");
        expect(world.told()).toEqual([{ to: "one", prompt: followUp([SANDBOX_LEXER]) }]);
        expect(world.filed.slice(1).map(({ at }) => at)).toEqual([3_000]);
    });

    // Lands arriving faster than the check runs must not keep a failure from ever being owed to anybody.
    test("waits at most three times in a row before it is routed regardless", async () => {
        const world = fleet([{ id: "one" }]);
        const kinds: (string | undefined)[] = [];
        for (const runAt of [1_000, 2_000, 3_000, 4_000]) {
            const fresh = runAt === 1_000 ? [SANDBOX_TEST] : [];
            kinds.push((await route(world, red({ runAt, fresh, queuedBehind: true })))?.kind);
        }

        expect(kinds).toEqual(["waiting", "waiting", "waiting", "original"]);
        expect(world.filed.map(({ at }) => at)).toEqual([1_000, 2_000, 3_000, 4_000]);
    });
});

describe("a red a conversation still working touches", () => {
    const heldNote = [
        "The main tree's own check in the workspace root went red after other work landed, on `_sandbox/sandbox`, which your unlanded work here also touches.",
        "Nothing else is being started on it while you work. If your change already fixes it, finish as usual; the check runs again when your work lands. Its failures:",
        `- ${SANDBOX_TEST}`,
    ].join("\n\n");

    test("is held on it, which is told once, and routed when it stops", async () => {
        const world = fleet([{ id: "one" }, { id: "busy", running: true }]);
        unlanded.set("busy", ["_sandbox/sandbox/src/parser.ts"]);

        const held = await decided(route(world, red()));

        expect(held).toEqual(
            routed("held", {
                conversationId: "busy",
                detail: "A conversation still working touches what failed; nothing else starts until it stops.",
            }),
        );
        expect(world.told()).toEqual([{ to: "busy", prompt: heldNote }]);
        expect(world.filed).toEqual([{ project: "", at: 1_000, routing: held, suspects: ["one"] }]);
        expect(world.types()).toEqual(["deps.breakage_held"]);

        // Another red while it still works holds again, and it is not told twice.
        await route(world, red({ runAt: 2_000, fresh: [SANDBOX_LEXER], failures: [SANDBOX_TEST, SANDBOX_LEXER] }));
        expect(world.told().map(({ to }) => to)).toEqual(["busy"]);

        world.running.delete("busy");
        await breakageRunSettled(world.services, "busy");

        await waitFor(() => expect(world.told().map(({ to }) => to)).toEqual(["busy", "one"]));
        expect(world.told()[1]?.prompt).toBe(followUp([SANDBOX_TEST, SANDBOX_LEXER]));
        const sent = routed("original", { conversationId: "one", detail: "Sent back to the conversation that landed it (1 of 2)." });
        await waitFor(() =>
            expect(world.filed.slice(-2)).toEqual([
                { project: "", at: 1_000, routing: sent, suspects: ["one"] },
                { project: "", at: 2_000, routing: sent, suspects: ["one"] },
            ]),
        );
    });

    test("is not held on a conversation whose unlanded work touches another package", async () => {
        const world = fleet([{ id: "one" }, { id: "busy", running: true }]);
        unlanded.set("busy", ["_editor/web/src/App.vue"]);

        expect((await route(world, red()))?.kind).toBe("original");
        expect(world.told().map(({ to }) => to)).toEqual(["one"]);
    });

    test("waits for every conversation it is held on to stop", async () => {
        const world = fleet([{ id: "one" }, { id: "busy", running: true }, { id: "also", running: true }]);
        unlanded.set("busy", ["_sandbox/sandbox/src/parser.ts"]);
        unlanded.set("also", ["_sandbox/sandbox/src/lexer.ts"]);
        await route(world, red());
        expect(
            world
                .told()
                .map(({ to }) => to)
                .toSorted(),
        ).toEqual(["also", "busy"]);

        world.running.delete("busy");
        await breakageRunSettled(world.services, "busy");
        // A conversation it was never held on stopping changes nothing either.
        await breakageRunSettled(world.services, "one");
        // Room for anything the first stop set moving to have moved.
        await realSleep(50);
        expect(world.told()).toHaveLength(2);
        expect(world.filed).toHaveLength(1);

        world.running.delete("also");
        await breakageRunSettled(world.services, "also");
        await waitFor(() =>
            expect(
                world
                    .told()
                    .map(({ to }) => to)
                    .at(-1),
            ).toBe("one"),
        );
    });

    // The suspect is asked about its own land once it stops, never told about it mid-turn.
    test("is held without a word on the suspect itself while it works, and sent to it once it stops", async () => {
        const world = fleet([{ id: "one", running: true }]);

        expect(await route(world, red())).toEqual(
            routed("held", {
                conversationId: "one",
                detail: "A conversation still working touches what failed; nothing else starts until it stops.",
            }),
        );
        expect(world.told()).toEqual([]);

        world.running.delete("one");
        await breakageRunSettled(world.services, "one");

        await waitFor(() => expect(world.told()).toEqual([{ to: "one", prompt: followUp([SANDBOX_TEST]) }]));
    });

    // A long session must not keep the main tree red for hours: past the bound the red is routed while it still works.
    test("is routed regardless once it has been held for forty-five minutes", async () => {
        jest.useFakeTimers();
        const world = fleet([{ id: "one" }, { id: "busy", running: true }]);
        unlanded.set("busy", ["_sandbox/sandbox/src/parser.ts"]);
        expect((await route(world, red()))?.kind).toBe("held");

        await advanceTimersByTimeAsync(45 * 60_000);

        await waitFor(() => expect(world.told().map(({ to }) => to)).toEqual(["busy", "one"]));
        expect(world.running.has("busy")).toBe(true);
        await waitFor(() => expect(world.filed.at(-1)?.routing.kind).toBe("original"));
    });

    test("is resolved without anybody sent when the next check is green", async () => {
        const world = fleet([{ id: "one" }, { id: "busy", running: true }]);
        unlanded.set("busy", ["_sandbox/sandbox/src/parser.ts"]);
        await route(world, red());

        await breakageSettled(world.services, "", undefined);
        world.running.delete("busy");
        await breakageRunSettled(world.services, "busy");

        await waitFor(() =>
            expect(world.filed.at(-1)?.routing).toEqual(routed("resolved", { detail: "Green at the next check, before anybody was sent." })),
        );
        expect(world.told().map(({ to }) => to)).toEqual(["busy"]);
    });
});

/* A RESTART. What the router carries lives in the verify store, so a daemon that stopped mid-streak picks it up again. */

describe("a daemon restarted mid-streak", () => {
    test("releases a hold whose conversation stopped while it was down, and routes the red", async () => {
        const world = fleet([{ id: "one" }, { id: "busy", running: true }]);
        unlanded.set("busy", ["_sandbox/sandbox/src/parser.ts"]);
        await world.services.verifyStore.record("", "red", 1_000, [SANDBOX_TEST]);
        expect((await route(world, red()))?.kind).toBe("held");

        // The daemon stops: its timers go, and the conversation's end is never heard.
        resetBreakageRouter();
        world.running.delete("busy");
        await resumeBreakageRouter(world.services);

        expect(world.told().map(({ to }) => to)).toEqual(["busy", "one"]);
        expect(world.filed.at(-1)?.routing).toEqual(
            routed("original", { conversationId: "one", detail: "Sent back to the conversation that landed it (1 of 2)." }),
        );
    });

    test("keeps a hold on a conversation still working, and tells it nothing twice", async () => {
        const world = fleet([{ id: "one" }, { id: "busy", running: true }]);
        unlanded.set("busy", ["_sandbox/sandbox/src/parser.ts"]);
        await world.services.verifyStore.record("", "red", 1_000, [SANDBOX_TEST]);
        await route(world, red());

        resetBreakageRouter();
        await resumeBreakageRouter(world.services);

        expect(world.told().map(({ to }) => to)).toEqual(["busy"]);
        expect(world.filed.map(({ routing }) => routing.kind)).toEqual(["held"]);
        expect((await world.services.verifyStore.streaks())[""]?.carried?.on).toEqual(["busy"]);
    });

    test("decides a red that waited on a check the restart left nothing ahead of", async () => {
        const world = fleet([{ id: "one" }]);
        await world.services.verifyStore.record("", "red", 1_000, [SANDBOX_TEST]);
        await route(world, red({ queuedBehind: true }));

        resetBreakageRouter();
        await resumeBreakageRouter(world.services);

        expect(world.told().map(({ to }) => to)).toEqual(["one"]);
        expect((await world.services.verifyStore.streaks())[""]?.carried).toBeUndefined();
    });

    test("leaves a waiting red to the check still ahead of it", async () => {
        const world = fleet([{ id: "one" }]);
        await world.services.verifyStore.record("", "red", 1_000, [SANDBOX_TEST]);
        await route(world, red({ queuedBehind: true }));
        world.ahead.value = true;

        await resumeBreakageRouter(world.services);

        expect(world.told()).toEqual([]);
        expect((await world.services.verifyStore.streaks())[""]?.carried?.runs).toEqual([1_000]);
    });

    // The follow-ups a conversation was sent are read off the runs they were filed on.
    test("counts the follow-ups already sent this streak from the runs, not from memory", async () => {
        const world = fleet([{ id: "one" }]);
        await route(world, red());

        resetBreakageRouter();
        const second = await route(world, red({ runAt: 2_000, fresh: [SANDBOX_LEXER], failures: [SANDBOX_TEST, SANDBOX_LEXER] }));

        expect(second).toEqual(routed("original", { conversationId: "one", detail: "Sent back to the conversation that landed it (2 of 2)." }));
    });
});
