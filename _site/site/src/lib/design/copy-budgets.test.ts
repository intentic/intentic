import { COPY_BUDGETS, CopyBudgetError, countWords, held } from "./copy-budgets";

describe("countWords", () => {
    test("counts runs that carry a letter or a digit", () => {
        expect(countWords("Run agents. Connect your tools.")).toBe(5);
        expect(countWords("  $20 a month  ")).toBe(3);
    });

    test("punctuation and arrows standing alone are not words", () => {
        expect(countWords("See it →")).toBe(2);
        expect(countWords("Install — sign in · run")).toBe(4);
    });

    test("an empty string is no words", () => {
        expect(countWords("")).toBe(0);
        expect(countWords("   ")).toBe(0);
    });
});

describe("held", () => {
    test("returns a string that fits its slot unchanged", () => {
        expect(held("heading", "Share the agents, not the keys.", "test")).toBe("Share the agents, not the keys.");
    });

    test("passes an absent string through", () => {
        expect(held("lede", undefined, "test")).toBeUndefined();
    });

    test("a string at the ceiling fits", () => {
        const atCeiling = Array.from({ length: COPY_BUDGETS.title.max }, () => "word").join(" ");
        expect(held("title", atCeiling, "test")).toBe(atCeiling);
    });

    test("a string over its ceiling fails, naming the slot, the count and the way out", () => {
        const lede = "Invite a teammate, a client or a CI job. Each one gets in through its own door and reaches only what its grant allows.";
        let failure: CopyBudgetError | undefined;
        try {
            held("lede", lede, "Kit/SectionHead");
        } catch (error) {
            if (error instanceof CopyBudgetError) {
                failure = error;
            }
        }
        if (failure === undefined) {
            throw new Error("an over-budget lede rendered");
        }
        expect(failure.slot).toBe("lede");
        expect(failure.words).toBe(countWords(lede));
        expect(failure.message).toContain("Kit/SectionHead");
        expect(failure.message).toContain("Tip");
    });
});

describe("COPY_BUDGETS", () => {
    test("every aim sits at or under its ceiling", () => {
        for (const [slot, { max, aim }] of Object.entries(COPY_BUDGETS)) {
            expect(aim, slot).toBeLessThanOrEqual(max);
        }
    });

    test("the Tip's title and rows hold to the app's tooltip limits", () => {
        // _tools/checks/tooltip-words.mjs: title 3, rowLabel 2.
        expect(COPY_BUDGETS.tipTitle.max).toBe(3);
        expect(COPY_BUDGETS.tipRow.max).toBe(2);
    });
});
