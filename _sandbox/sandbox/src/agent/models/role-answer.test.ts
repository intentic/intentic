import { expect, test } from "vitest";
import { type RoleAnswer, readRoleAnswer, sentenceAnswer, sentenceReason, UnusableAnswerError } from "./role-answer.js";

// Pins what counts as an answer across every role-answer helper. UnusableAnswerError means step over this reply; an
// ordinary Error means the rung itself is down.

// Stand-in for one caller's contract: first line, capped well under a title's own ceiling.
const title = sentenceAnswer(`a session title`, (reply) => reply.trim().split(`\n`)[0]?.trim() ?? ``, 12);

const read = (reply: string): string => readRoleAnswer(title, reply);

test("an ordinary reply comes back read and unwrapped", () => {
    expect(read(`Sandbox freezes · fix`)).toBe(`Sandbox freezes · fix`);
    expect(read(`Sandbox freezes · fix\n\nI named it that because…`)).toBe(`Sandbox freezes · fix`);
});

test("a tool-call stand-in is a reply to step over, not a name", () => {
    for (const reply of [
        `[tool_call: glob for pattern '**']`,
        `[tool_call: ls for path '/work']\n[tool_call: read for absolute_path '/work/README.md']`,
        `<tool_call>{"name":"Glob","arguments":{"pattern":"**"}}</tool_call>`,
        // Block form's payload sits below the opener, so dropping just the opener leaves `glob('**')` standing.
        "```tool_code\nglob('**')\n```",
        `<tool_call>\n{"name":"Glob","arguments":{"pattern":"**"}}\n</tool_call>`,
    ]) {
        expect(() => read(reply)).toThrow(UnusableAnswerError);
        expect(() => read(reply)).toThrow(/tool call/i);
    }
});

test("a stand-in takes its whole line with it, tail included", () => {
    expect(() => read(`[tool_call: grep for pattern 'gone quiet|offline'] Bluntly search th`)).toThrow(UnusableAnswerError);
});

test("an answer under a narrated tool call is still an answer", () => {
    expect(read(`[tool_call: glob for pattern '**']\nSandbox freezes · fix`)).toBe(`Sandbox freezes · fix`);
});

test("an answer that mentions a stand-in mid-line is not one", () => {
    expect(read(`fix(role-model): refuse a [tool_call: …] reply as an answer`)).toBe(`fix(role-model): refuse a [tool_call: …] reply as an answer`);
});

test("a provider's failure sentence is a refusal to remember, not a reply to step over", () => {
    const failure = `Failed to authenticate. API Error: 401 OAuth access token has been revoked`;
    expect(() => read(failure)).toThrow(failure);
    expect(() => read(failure)).not.toThrow(UnusableAnswerError);
});

test("a model that answered the asker instead of the ask has not answered", () => {
    expect(() => read(`I need more context to name this session. What feature does it touch?`)).toThrow(UnusableAnswerError);
    expect(() => read(`I need more context to name this session. What feature does it touch?`)).toThrow(/answered the asker/);
    expect(() => read(`Claude Haiku`)).toThrow(UnusableAnswerError);
    expect(() => read(`Claude Haiku`)).toThrow(/answered the asker/);
    expect(() => read(`I am Claude`)).toThrow(UnusableAnswerError);
});

// Ceiling is per-caller, since only the caller knows what it asked for; refusing, not truncating, avoids storing a
// fragment of a paragraph.
test("an answer-shaped blob is refused, not truncated", () => {
    const blob = `The session appears to be about investigating why some titles look wrong, though I would need more of the transcript`;
    expect(() => read(blob)).toThrow(UnusableAnswerError);
    expect(sentenceReason(`a session title`, blob, 12)).toMatch(/words where a session title takes at most 12/);
});

test("nothing at all is nothing, and says so", () => {
    expect(() => read(``)).toThrow(/answered with nothing/);
    expect(() => read(`   \n\n `)).toThrow(/answered with nothing/);
});

// Usability is judged on `subject` alone; a missing `note` is still an answer, a missing `subject` is not.
test("carries a composite answer, judged on the field that matters", () => {
    const message: RoleAnswer<{ subject: string; note: string }> = {
        what: `a commit subject`,
        read: (reply) => {
            const lines = reply.trim().split(`\n`);
            return { subject: lines[0]?.trim() ?? ``, note: lines.find((line) => line.startsWith(`Release-Note:`))?.slice(14).trim() ?? `` };
        },
        unusable: ({ subject }) => sentenceReason(`a commit subject`, subject, 20),
    };

    expect(readRoleAnswer(message, `fix: stop naming sessions after tool calls`)).toEqual({
        subject: `fix: stop naming sessions after tool calls`,
        note: ``,
    });
    expect(readRoleAnswer(message, `fix: stop naming sessions after tool calls\nRelease-Note: Sessions get real names again.`).note).toBe(
        `Sessions get real names again.`,
    );
    expect(() => readRoleAnswer(message, `[tool_call: bash for 'git log -1']`)).toThrow(UnusableAnswerError);
});
