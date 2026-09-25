import type { MainlineRun } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { type KnownRed, LANDING_CHECKS_NOTE_HEADER, LANDING_CHECKS_NOTE_TITLE, landingChecksNote, landingChecksNoteFor } from "./mainline-note.js";
import type { VerifyOutcome } from "./verify-store.js";

// What a turn is told about checks: nothing checks its work when it ends, the main tree's own check runs after it lands,
// and which failures the main tree already has. Said when due, and again only when those reds move under a conversation.

const AT_14_05 = Date.UTC(2026, 8, 25, 14, 5);
const AT_09_30 = Date.UTC(2026, 8, 25, 9, 30);

const BASE_LINE =
    "Nothing checks your work when you finish, and nothing holds it back: you decide when it is done. After it lands, the main tree's own check runs in the background. A failure traced to your work comes back to this conversation as a message; anything else goes to a fresh conversation. Run whatever checks you judge worth running while you work; none is required before you finish.";

// The verify store as the note reads it, red or green per project as each case sets it.
const mainLine = () => {
    const projects: Record<string, VerifyOutcome> = {};
    let runs: MainlineRun[] = [];
    const warned: unknown[] = [];
    const deps: Pick<Services, "verifyStore" | "logger"> = {
        verifyStore: unstubbed<Services["verifyStore"]>("verifyStore", { read: async () => ({ projects, runs }) }),
        logger: unstubbed<Services["logger"]>("logger", { warn: (...line: unknown[]) => void warned.push(line[1]) }),
    };
    const redden = (project: string, since: number, failures: readonly string[]): void => {
        projects[project] = { status: "red", attempt: 1, at: since, failures: [...failures], since };
        runs = [
            {
                project,
                command: "pnpm verify",
                status: "red",
                startedAt: since - 1,
                at: since,
                lands: [],
                failures: [...failures],
                failureCount: failures.length,
                attempt: 1,
            },
            ...runs,
        ];
    };
    const green = (project: string): void => {
        projects[project] = { status: "green", attempt: 0, at: AT_14_05 + 1 };
    };
    return { deps, redden, green, warned };
};

describe("the note", () => {
    test("says nothing checks the work when it finishes, what runs after it lands, and names no reds on a green main line", () => {
        expect(landingChecksNote([], false)).toEqual({ title: LANDING_CHECKS_NOTE_TITLE, text: `${LANDING_CHECKS_NOTE_HEADER}\n\n${BASE_LINE}` });
    });

    test("lists what the main tree is already red on, per project, before any of the turn's work lands", () => {
        const reds: KnownRed[] = [
            { project: "", since: AT_14_05, failures: ["root#test a.test.ts › x"], failureCount: 1, lands: [] },
            {
                project: "apps/web",
                since: AT_09_30,
                failures: Array.from({ length: 10 }, (_, index) => `web#test t${index}.test.ts`),
                failureCount: 12,
                lands: ["Fix the parser", "c-2"],
            },
            { project: "lib", since: AT_14_05, failures: [], failureCount: 0, lands: [] },
        ];

        expect(landingChecksNote(reds, false).text).toBe(
            [
                LANDING_CHECKS_NOTE_HEADER,
                "",
                BASE_LINE,
                "",
                "The main tree is already red on these, before any of your work lands. They are not yours to chase unless your task is about them:",
                "",
                "- the workspace root: 1 failure since 14:05 UTC",
                "  - `root#test a.test.ts › x`",
                '- `apps/web`: 12 failures since 09:30 UTC, after "Fix the parser", "c-2" landed',
                ...Array.from({ length: 8 }, (_, index) => `  - \`web#test t${index}.test.ts\``),
                "  - …and 4 more",
                "- `lib`: red since 14:05 UTC",
            ].join("\n"),
        );
    });

    test("says the main tree is green again when the conversation was last told it was red", () => {
        expect(landingChecksNote([], true).text).toBe(
            `${LANDING_CHECKS_NOTE_HEADER}\n\n${BASE_LINE}\n\nThe main tree's own check is green again: a failure you see from here on is worth reading as your own.`,
        );
    });
});

describe("when a conversation is told", () => {
    test("whenever the note is due, with the reds as they stand", async () => {
        const line = mainLine();
        line.redden("app", AT_14_05, ["app#test a.test.ts › x"]);

        const note = await landingChecksNoteFor(line.deps, "c-due", true);

        expect(note?.title).toBe(LANDING_CHECKS_NOTE_TITLE);
        expect(note?.text).toContain("- `app`: 1 failure since 14:05 UTC\n  - `app#test a.test.ts › x`");
        // Told once; the next turn owes nothing while nothing moved.
        expect(await landingChecksNoteFor(line.deps, "c-due", false)).toBeUndefined();
    });

    // One it has not told since the daemon started heard the reds before a restart, or on an opening another daemon
    // sent; from here on a change is news.
    test("never on a follow-up it has not told since it started, until the reds move", async () => {
        const line = mainLine();
        line.redden("app", AT_14_05, ["x"]);

        expect(await landingChecksNoteFor(line.deps, "c-restarted", false)).toBeUndefined();
        expect(await landingChecksNoteFor(line.deps, "c-restarted", false)).toBeUndefined();

        line.redden("lib", AT_09_30, ["y", "z"]);
        const note = await landingChecksNoteFor(line.deps, "c-restarted", false);
        expect(note?.text).toContain("- `app`: 1 failure since 14:05 UTC");
        expect(note?.text).toContain("- `lib`: 2 failures since 09:30 UTC");
    });

    test("again on a follow-up when a red it was told of grows, and not while it stands still", async () => {
        const line = mainLine();
        line.redden("app", AT_14_05, ["x"]);
        await landingChecksNoteFor(line.deps, "c-grows", true);

        line.redden("app", AT_14_05, ["x", "y"]);
        expect((await landingChecksNoteFor(line.deps, "c-grows", false))?.text).toContain("- `app`: 2 failures since 14:05 UTC");
        expect(await landingChecksNoteFor(line.deps, "c-grows", false)).toBeUndefined();
    });

    test("once more when the reds it was told of clear, to say the main tree is green again", async () => {
        const line = mainLine();
        line.redden("app", AT_14_05, ["x"]);
        await landingChecksNoteFor(line.deps, "c-cleared", true);

        line.green("app");
        const note = await landingChecksNoteFor(line.deps, "c-cleared", false);

        expect(note?.text).toContain("The main tree's own check is green again");
        expect(note?.text).not.toContain("already red");
        expect(await landingChecksNoteFor(line.deps, "c-cleared", false)).toBeUndefined();
    });

    // Green when told and green now: nothing was red, so nothing is green "again".
    test("never green again on a due note to a conversation only ever told of a green main line", async () => {
        const line = mainLine();
        await landingChecksNoteFor(line.deps, "c-green", true);

        expect(await landingChecksNoteFor(line.deps, "c-green", true)).toEqual(landingChecksNote([], false));
    });

    test("on a turn with no conversation when it is due, keeping nothing to compare against", async () => {
        const line = mainLine();
        line.redden("app", AT_14_05, ["x"]);

        expect((await landingChecksNoteFor(line.deps, undefined, true))?.text).toContain("- `app`: 1 failure since 14:05 UTC");
        expect(await landingChecksNoteFor(line.deps, undefined, false)).toBeUndefined();
    });

    test("that the main line reads green when its verdicts cannot be read, and the log says so", async () => {
        const warned: unknown[] = [];
        const deps: Pick<Services, "verifyStore" | "logger"> = {
            verifyStore: unstubbed<Services["verifyStore"]>("verifyStore", {
                read: async () => {
                    throw new Error("EACCES: verify.json");
                },
            }),
            logger: unstubbed<Services["logger"]>("logger", { warn: (...line: unknown[]) => void warned.push(line[1]) }),
        };

        expect(await landingChecksNoteFor(deps, "c-unreadable", true)).toEqual(landingChecksNote([], false));
        expect(warned).toEqual(["landing checks note: the main line's verdicts could not be read"]);
    });
});
