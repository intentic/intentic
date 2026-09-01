import { expect, test } from "vitest";
import { type QuickAnswer, readQuickAnswer, sentenceAnswer, sentenceReason, UnusableAnswerError } from "./quick-answer.js";

/* WHAT COUNTS AS AN ANSWER, for every helper that goes through the quick model. The four kinds of reply that are
 * not one all reached a durable field at some point, one file at a time (quick-answer.ts tells that story), so
 * they are pinned HERE, once, at the seam they now share.
 *
 * The two throws are deliberately different types and the tests say which is which: an UnusableAnswerError is a
 * reply to step over, an ordinary Error is a rung to remember as down. Getting that backwards would either
 * sideline the sandbox's best model for hours over one bad sample, or keep re-asking an account that is out. */

// A stand-in for one caller's contract: the first line, and a ceiling a name reads well under.
const title = sentenceAnswer(`a session title`, (reply) => reply.trim().split(`\n`)[0]?.trim() ?? ``, 12);

const read = (reply: string): string => readQuickAnswer(title, reply);

test("an ordinary reply comes back read and unwrapped", () => {
    expect(read(`Sandbox freezes · fix`)).toBe(`Sandbox freezes · fix`);
    expect(read(`Sandbox freezes · fix\n\nI named it that because…`)).toBe(`Sandbox freezes · fix`);
});

/* THE REPLY THIS SEAM WAS BUILT FOR. OpenCode prepends its own coding-agent prompt to a Gemini rung's request,
 * and that prompt's worked examples show the assistant "using a tool" by TYPING the call. Handed a naming prompt
 * and no tools, the cheap rung does exactly that, and four fleet cards plus three commits in this repo's own
 * history are named after it. */
test("a tool-call stand-in is a reply to step over, not a name", () => {
    for (const reply of [
        `[tool_call: glob for pattern '**']`,
        `[tool_call: ls for path '/work']\n[tool_call: read for absolute_path '/work/README.md']`,
        `<tool_call>{"name":"Glob","arguments":{"pattern":"**"}}</tool_call>`,
        // The block forms carry their payload on the lines below the opener, so the payload has to go with it:
        // dropping the opener alone would leave `glob('**')` standing and a card would wear it as an answer.
        "```tool_code\nglob('**')\n```",
        `<tool_call>\n{"name":"Glob","arguments":{"pattern":"**"}}\n</tool_call>`,
    ]) {
        expect(() => read(reply)).toThrow(UnusableAnswerError);
        expect(() => read(reply)).toThrow(/tool call/i);
    }
});

// The words after a stand-in are the model continuing its imagined transcript, not an answer that trails one:
// `[tool_call: grep for pattern '…'] Bluntly search th` is a real title this repo wore. The line goes whole.
test("a stand-in takes its whole line with it, tail included", () => {
    expect(() => read(`[tool_call: grep for pattern 'gone quiet|offline'] Bluntly search th`)).toThrow(UnusableAnswerError);
});

// …while a stand-in on a line of its own, followed by a real answer, keeps the answer: the model narrated and
// then did the job, and refusing that would spend a rung to punish its phrasing.
test("an answer under a narrated tool call is still an answer", () => {
    expect(read(`[tool_call: glob for pattern '**']\nSandbox freezes · fix`)).toBe(`Sandbox freezes · fix`);
});

// And an answer that TALKS about one lands untouched, which is what anchoring on the line start buys: this
// repo's own commit subject for this change would otherwise be unwritable.
test("an answer that mentions a stand-in mid-line is not one", () => {
    expect(read(`fix(quick-model): refuse a [tool_call: …] reply as an answer`)).toBe(`fix(quick-model): refuse a [tool_call: …] reply as an answer`);
});

/* A LASTING CONDITION WEARING AN ANSWER'S CLOTHES. Some providers hand a helper its spent allowance or dead
 * credential as the reply TEXT rather than as an error, and that is the one case here worth remembering: the
 * rung is out, so it is thrown as an ordinary refusal for the walk's memo to pick up. */
test("a provider's failure sentence is a refusal to remember, not a reply to step over", () => {
    const failure = `Failed to authenticate. API Error: 401 OAuth access token has been revoked`;
    expect(() => read(failure)).toThrow(failure);
    expect(() => read(failure)).not.toThrow(UnusableAnswerError);
});

test("a model that answered the asker instead of the ask has not answered", () => {
    expect(() => read(`I need more context to name this session. What feature does it touch?`)).toThrow(UnusableAnswerError);
    expect(() => read(`I need more context to name this session. What feature does it touch?`)).toThrow(/answered the asker/);
});

/* THE ANSWER-SHAPED REPLY, and the reason it is refused rather than cut down to size: a title is a few-word
 * task, so a reply of many words is a model that ignored the task and answered something else, and storing the
 * first 80 characters of that stores a fragment of an assistant's paragraph. hermes-agent's own guard makes the
 * same call for the same reason; the ceiling is per-caller because only the caller knows what it asked for. */
test("an answer-shaped blob is refused, not truncated", () => {
    const blob = `The session appears to be about investigating why some titles look wrong, though I would need more of the transcript`;
    expect(() => read(blob)).toThrow(UnusableAnswerError);
    expect(sentenceReason(`a session title`, blob, 12)).toMatch(/words where a session title takes at most 12/);
});

test("nothing at all is nothing, and says so", () => {
    expect(() => read(``)).toThrow(/answered with nothing/);
    expect(() => read(`   \n\n `)).toThrow(/answered with nothing/);
});

/* ONE REPLY, SEVERAL FIELDS, and only one of them decides: a landing reads a commit subject plus two optional
 * trailers out of a single reply, so a reply with no note is an ordinary answer while a reply with no subject is
 * no answer at all. This is what the contract being a `read` into any value (rather than a string cleaner) is
 * for, and it is the shape t3code's schema-decoded helpers land on too. */
test("carries a composite answer, judged on the field that matters", () => {
    const message: QuickAnswer<{ subject: string; note: string }> = {
        what: `a commit subject`,
        read: (reply) => {
            const lines = reply.trim().split(`\n`);
            return { subject: lines[0]?.trim() ?? ``, note: lines.find((line) => line.startsWith(`Release-Note:`))?.slice(14).trim() ?? `` };
        },
        unusable: ({ subject }) => sentenceReason(`a commit subject`, subject, 20),
    };

    expect(readQuickAnswer(message, `fix: stop naming sessions after tool calls`)).toEqual({
        subject: `fix: stop naming sessions after tool calls`,
        note: ``,
    });
    expect(readQuickAnswer(message, `fix: stop naming sessions after tool calls\nRelease-Note: Sessions get real names again.`).note).toBe(
        `Sessions get real names again.`,
    );
    expect(() => readQuickAnswer(message, `[tool_call: bash for 'git log -1']`)).toThrow(UnusableAnswerError);
});
