import { spokenReplyPrompt } from "./spoken-reply.js";

/* What the spoken-reply job is asked: speech rather than a summary, in the person's language, about this reply. */

test("asks for a few spoken sentences in the language named, with the ask and the reply beside it", () => {
    const prompt = spokenReplyPrompt({ reply: "Done. The form rejects empty passwords.", asked: "Popraw formularz", language: "pl" });
    expect(prompt).toContain("Write it in Polish.");
    expect(prompt).toContain("<asked>\nPopraw formularz\n</asked>");
    expect(prompt).toContain("<reply>\nDone. The form rejects empty passwords.\n</reply>");
    expect(prompt).toContain("no markdown");
});

test("a long reply keeps its opening and its end, where it asks", () => {
    const reply = `OPENING ${"middle ".repeat(3_000)} ENDING?`;
    const prompt = spokenReplyPrompt({ reply, asked: undefined, language: "en" });
    expect(prompt).toContain("OPENING");
    expect(prompt).toContain("ENDING?");
    expect(prompt.length).toBeLessThan(8_000);
    expect(prompt).not.toContain("<asked>");
});
