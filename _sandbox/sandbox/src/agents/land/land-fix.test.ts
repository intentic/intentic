import { type AgentSummary, isLandFix, LAND_FIX_OPENING, landFixConversationId } from "@intentic/sandbox-contract";
import type { GitRunner } from "@intentic/scaffold";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import type { SentTurn } from "../../seams/turn-starter.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import type { LandBreakage } from "../../workspace/deps/verify-deps.js";
import { landChange, landFixBrief, type LandSuspect, startLandFix } from "./land-fix.js";

// The fresh conversation a red main line is handed when no conversation holding the work can take it: what it opens on
// is all it knows, so the brief is the subject here. Which red gets one is land-breakage.test.ts's.

const MAIN = "/w";
const FAILING = "@intentic/sandbox#test _sandbox/sandbox/src/parser.test.ts › parses a heading";

const land = (agentId: string, title?: string): DependencyLandOrigin => ({
    kind: "land",
    agentId,
    ...(title === undefined ? {} : { title }),
    branch: `agent/${agentId}`,
    repos: [{ repo: "root", from: `from-${agentId}`, dir: "" }],
});

const suspect = (agentId: string, paths: readonly string[], title?: string): LandSuspect => ({
    land: land(agentId, title),
    paths,
    from: `from-${agentId}`,
    tip: `tip-${agentId}`,
});

const breakage = (over: Partial<LandBreakage> = {}): LandBreakage => ({
    project: "",
    command: "pnpm verify",
    lands: [land("one", "Fix the parser")],
    fresh: [FAILING],
    failures: [FAILING],
    logTail: "\n  1 failed\n",
    runAt: 2_000,
    redSince: 1_000,
    queuedBehind: false,
    measured: true,
    ...over,
});

describe("the brief a fresh fix-up opens on", () => {
    test("opens as the contract's own fix-up, then names the check, where it ran and what failed", () => {
        const brief = landFixBrief({ breakage: breakage(), suspects: [suspect("one", ["_sandbox/sandbox/src/parser.ts"])], named: true }, MAIN);

        expect(brief.startsWith(`${LAND_FIX_OPENING}\n\n`)).toBe(true);
        expect(isLandFix(brief)).toBe(true);
        expect(brief).toContain(`\`pnpm verify\` in the workspace root failed on:\n\n- ${FAILING}`);
        expect(landFixBrief({ breakage: breakage({ project: "apps/web" }), suspects: [], named: false }, MAIN)).toContain(
            "`pnpm verify` in `apps/web` failed on:",
        );
    });

    test("names a suspect by its title, lists what it changed, and says how to read its change and its conversation", () => {
        const brief = landFixBrief(
            {
                breakage: breakage(),
                suspects: [suspect("one", ["_sandbox/sandbox/src/parser.ts", "_sandbox/sandbox/src/lexer.ts"], "Fix the parser")],
                named: true,
            },
            MAIN,
        );

        expect(brief).toContain(
            [
                `**"Fix the parser" (\`one\`)**`,
                "- _sandbox/sandbox/src/parser.ts",
                "- _sandbox/sandbox/src/lexer.ts",
                "Its change alone: `git -C /w diff from-one tip-one`",
                "What it was asked and what it did: `agents show one`",
            ].join("\n"),
        );
    });

    // Without both ends of its span there is no exact diff to point at, and a guessed one would be worse than none.
    test("points at no diff for a land whose ends are not both known, and names an untitled one by its id", () => {
        const untitled: LandSuspect = { land: land("two"), paths: [], from: "from-two", tip: undefined };

        const brief = landFixBrief({ breakage: breakage(), suspects: [untitled], named: true }, MAIN);

        expect(brief).toContain("**`two`**\nWhat it was asked and what it did: `agents show two`");
        expect(brief).not.toContain("Its change alone");
    });

    test.each([
        ["one land named", [suspect("one", [])], true, "These failures arrived with this land:"],
        ["several lands named", [suspect("one", []), suspect("two", [])], true, "These failures arrived with one of these lands:"],
        [
            "no land named",
            [suspect("one", []), suspect("two", [])],
            false,
            "No single land could be named for them; these are every land the red check covered:",
        ],
    ] as const)("says how sure the blame is with %s", (_case, suspects, named, line) => {
        expect(landFixBrief({ breakage: breakage(), suspects, named }, MAIN)).toContain(line);
    });

    // Several suspects are told apart by reverting one at a time and re-running only the failures, never the suite.
    test("asks for the failing tests alone, and for telling several suspects apart before changing anything", () => {
        const one = landFixBrief({ breakage: breakage(), suspects: [suspect("one", [])], named: true }, MAIN);
        const two = landFixBrief({ breakage: breakage(), suspects: [suspect("one", []), suspect("two", [])], named: false }, MAIN);

        expect(one).toContain("Start by re-running only the failing tests, not the whole suite");
        expect(one).not.toContain("With several suspects");
        expect(two).toContain("With several suspects, tell them apart before changing anything");
    });

    test("carries why the conversation that landed it was passed over, when one was", () => {
        const passedOver = 'The conversation that landed it ("Fix the parser") has gone cold or is nearly full.';

        expect(landFixBrief({ breakage: breakage(), suspects: [suspect("one", [])], named: true, passedOver }, MAIN)).toContain(
            `\n\n${passedOver}\n\n`,
        );
        expect(landFixBrief({ breakage: breakage(), suspects: [suspect("one", [])], named: true }, MAIN)).not.toContain(
            "The conversation that landed it",
        );
    });

    test("ends on the check's own output, trimmed and fenced", () => {
        expect(
            landFixBrief({ breakage: breakage(), suspects: [], named: false }, MAIN).endsWith("The end of the check's output:\n\n```\n1 failed\n```"),
        ).toBe(true);
    });

    test("lists thirty failures and twenty files at most, and counts the rest", () => {
        const fresh = Array.from({ length: 32 }, (_, index) => `app#test t${index}.test.ts › x`);
        const paths = Array.from({ length: 23 }, (_, index) => `app/src/f${index}.ts`);

        const brief = landFixBrief({ breakage: breakage({ fresh }), suspects: [suspect("one", paths)], named: true }, MAIN);

        expect(brief).toContain("- app#test t29.test.ts › x\n- …and 2 more");
        expect(brief).not.toContain("t30.test.ts");
        expect(brief).toContain("- app/src/f19.ts\n- …and 3 more");
        expect(brief).not.toContain("f20.ts");
    });
});

describe("the attempt it starts", () => {
    const fleet = (roster: AgentSummary[] = []) => {
        const started: SentTurn[] = [];
        const services = unstubbed<Services>("services", {
            agents: unstubbed<Services["agents"]>("agents", { list: () => roster, listArchived: () => [] }),
            agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {
                mainDir: (repo) => (repo === "root" ? MAIN : `${MAIN}/${repo}`),
            }),
            turns: unstubbed<Services["turns"]>("turns", {
                start: async (turn) => {
                    started.push(turn);
                    return { id: `run-${started.length}`, async *frames() {} };
                },
            }),
        });
        return { services, started };
    };

    // One red streak is one failure, so its id is the streak's; a later streak in the same project starts over.
    test("is started under the streak's own id, isolated, on the pipeline fixer's model, titled after the one land named", async () => {
        const { services, started } = fleet();
        const ask = { breakage: breakage(), suspects: [suspect("one", [], "Fix the parser")], named: true };

        const outcome = await startLandFix(services, ask);

        const id = landFixConversationId("", 1_000);
        expect(outcome).toEqual({ kind: "started", conversationId: id, attempt: 1, continued: false });
        expect(started).toEqual([
            {
                isolated: true,
                runRole: "pipeline-fix",
                prompt: landFixBrief(ask, MAIN),
                title: 'Fix main after "Fix the parser"',
                conversationId: id,
                byPerson: false,
            },
        ]);
    });

    test("is titled after the project when no single land was named, the workspace root by name", async () => {
        const { services, started } = fleet();

        await startLandFix(services, {
            breakage: breakage({ project: "apps/web" }),
            suspects: [suspect("one", []), suspect("two", [])],
            named: false,
        });
        await startLandFix(services, { breakage: breakage({ redSince: 9_000 }), suspects: [suspect("one", [])], named: false });

        expect(started.map(({ title, conversationId }) => ({ title, conversationId }))).toEqual([
            { title: "Fix main: apps/web", conversationId: landFixConversationId("apps/web", 1_000) },
            { title: "Fix main: workspace", conversationId: landFixConversationId("", 9_000) },
        ]);
    });
});

describe("what a land changed", () => {
    const quiet = unstubbed<Pick<Services, "agentWorktrees" | "logger">>("deps", {
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { mainDir: () => MAIN }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined }),
    });
    const tipped = (): string => "tip-one";

    test("is the diff from the commit it departed to the tip it landed, in the project's repository", async () => {
        const asked: (readonly string[])[] = [];
        const git: GitRunner = async (dir, args) => {
            asked.push([dir, ...args]);
            return { stdout: "_sandbox/sandbox/src/a.ts\n_sandbox/sandbox/src/b.ts\n", stderr: "" };
        };

        expect(await landChange(quiet, land("one"), "", tipped, git)).toEqual({
            land: land("one"),
            paths: ["_sandbox/sandbox/src/a.ts", "_sandbox/sandbox/src/b.ts"],
            from: "from-one",
            tip: "tip-one",
        });
        expect(asked).toEqual([[MAIN, "diff", "--name-only", "--no-renames", "from-one", "tip-one"]]);
    });

    test("names no paths, and asks git nothing, when the land never touched the project or its tip is unknown", async () => {
        const git: GitRunner = async () => {
            throw new Error("git was not to be asked");
        };

        expect(await landChange(quiet, land("one"), "apps/web", tipped, git)).toEqual({
            land: land("one"),
            paths: [],
            from: undefined,
            tip: undefined,
        });
        expect(await landChange(quiet, land("one"), "", () => undefined, git)).toEqual({
            land: land("one"),
            paths: [],
            from: "from-one",
            tip: undefined,
        });
    });

    test("names no paths for commits git no longer has, and says so", async () => {
        const warned: unknown[] = [];
        const deps = { ...quiet, logger: unstubbed<Services["logger"]>("logger", { warn: (...line: unknown[]) => void warned.push(line[1]) }) };
        const git: GitRunner = async () => {
            throw new Error("fatal: bad object tip-one");
        };

        expect(await landChange(deps, land("one"), "", tipped, git)).toEqual({ land: land("one"), paths: [], from: "from-one", tip: "tip-one" });
        expect(warned).toEqual(["land breakage: a land's changed paths could not be read"]);
    });
});
