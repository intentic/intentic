import { sentencesOf, speakableInline, speakableMarkdown, spokenFallback } from "./voice-text.js";

/* A coding agent's markdown as something a voice can say: what is announced, what is shortened, and how it is cut. */

const REPLY = [
    "Done. The login form now rejects an empty password before it calls the server",
    "(see `src/features/auth/LoginForm.vue:42`), and I added two tests.",
    "",
    "## What changed",
    "- `validatePassword` in [auth.ts](src/auth/auth.ts) → returns early",
    "- Tests: **2 new**, both pass ✅",
    "",
    "```ts",
    "const a = 1;",
    "const b = 2;",
    "```",
    "",
    "| File | Lines |",
    "|---|---|",
    "| a.ts | 3 |",
    "| b.ts | 4 |",
    "",
    "Docs at https://example.com/docs/auth?x=1 for details.",
    "",
    "Should a locked account show its own message, or the same one as a wrong password?",
].join("\n");

describe("speakableInline", () => {
    test("says a path by its file name and a link by its words", () => {
        expect(speakableInline("see `src/a/b/LoginForm.vue:42:7` and [the docs](https://x.dev/a)")).toBe("see LoginForm.vue and the docs");
    });
    test("says a bare URL by its host, and drops emphasis, arrows and emoji", () => {
        expect(speakableInline("**fixed** → at https://example.com/a/b?c=1 🎉")).toBe("fixed, at example.com");
    });
});

describe("speakableMarkdown", () => {
    const spoken = speakableMarkdown(REPLY, "en");
    test("announces code and tables instead of spelling them out", () => {
        expect(spoken).toContain("Code, 2 lines.");
        expect(spoken).toContain("A table of 2 rows.");
        expect(spoken).not.toContain("const a");
        expect(spoken).not.toContain("|");
    });
    test("closes headings and list items as sentences of their own", () => {
        expect(spoken).toContain("What changed.");
        expect(spoken).toContain("validatePassword in auth.ts, returns early.");
    });
    test("announces in the reply's language, with its plural forms", () => {
        expect(speakableMarkdown("```\na\nb\nc\n```\n\n| a | b |\n|--|--|\n| 1 | 2 |\n| 3 | 4 |", "pl")).toBe("Kod, 3 linie. Tabela, 2 wiersze.");
        expect(speakableMarkdown(`\`\`\`\n${  "x\n".repeat(5)  }\`\`\``, "pl")).toBe("Kod, 5 linii.");
    });
    test("falls back to English words for a language it has none for", () => {
        expect(speakableMarkdown("```\na\n```", "fi")).toBe("Code, 1 line.");
    });
});

describe("sentencesOf", () => {
    test("cuts at sentence ends, keeping version numbers and abbreviations whole", () => {
        expect(sentencesOf("Bumped it to v1.2.3 today, e.g. the core. Then every one of the tests passed. All good here, nothing else to do.")).toEqual([
            "Bumped it to v1.2.3 today, e.g. the core.",
            "Then every one of the tests passed.",
            "All good here, nothing else to do.",
        ]);
    });
    test("lets a very short sentence ride with the next", () => {
        expect(sentencesOf("Done. The login form now rejects an empty password.")).toEqual(["Done. The login form now rejects an empty password."]);
    });
    test("cuts a sentence too long to wait for at a comma", () => {
        const long = `${"word ".repeat(30).trim()}, ${"more ".repeat(30).trim()}, ${"last ".repeat(10).trim()}.`;
        const parts = sentencesOf(long);
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.every((part) => part.length <= 220)).toBe(true);
        expect(parts.join(" ").replaceAll(/\s+/gu, " ")).toBe(long);
    });
});

describe("spokenFallback", () => {
    test("keeps how the reply opens and the question it ends on, and nothing a listener cannot use", () => {
        const said = spokenFallback(REPLY, "en");
        expect(said.startsWith("Done. The login form now rejects an empty password")).toBe(true);
        expect(said.endsWith("Should a locked account show its own message, or the same one as a wrong password?")).toBe(true);
        expect(said).not.toContain("What changed");
        expect(said).not.toContain("validatePassword");
        expect(said).not.toContain("Code,");
        expect(said).not.toContain("table");
    });
    test("stops after the opening words of a long reply", () => {
        const long = Array.from({ length: 20 }, (_, index) => `This is sentence number ${index} of a long reply.`).join(" ");
        expect(spokenFallback(long, "en").split(/\s+/u).length).toBeLessThanOrEqual(50);
    });
});
