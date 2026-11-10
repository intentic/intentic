import { googleCompatible, SKIPPED_SIGNATURE, withSignedToolCalls } from "./trial-signatures.js";

// What's pinned here is the shape Gemini refuses: an assistant step whose first tool call carries no thought signature,
// which is exactly what the sandbox's translator sends back after the trial's first tool call.

interface Call {
    readonly id: string;
    readonly extra_content?: { readonly google?: { readonly thought_signature?: string; readonly other?: string } };
}
interface Message {
    readonly role: string;
    readonly content?: unknown;
    readonly tool_calls?: readonly Call[];
}

const call = (id: string, signature?: string): Call =>
    signature === undefined ? { id } : { id, extra_content: { google: { thought_signature: signature } } };

// SAFETY: the rewrite only ever adds a field to a call, so what went in as Messages comes back as Messages.
const rewrite = (messages: readonly Message[]): Message[] =>
    (JSON.parse(withSignedToolCalls(JSON.stringify({ model: `auto`, messages }))) as { messages: Message[] }).messages;

const signatures = (message: Message | undefined): (string | undefined)[] =>
    (message?.tool_calls ?? []).map((each) => each.extra_content?.google?.thought_signature);

describe("tool calls bound for Google's OpenAI-compatible surface", () => {
    it("signs the first call of every step that has lost its signature", () => {
        const sent = rewrite([
            { role: `user`, content: `read the readme` },
            { role: `assistant`, content: ``, tool_calls: [call(`call_1`)] },
            { role: `tool`, content: `hello` },
            { role: `assistant`, content: ``, tool_calls: [call(`call_2`), call(`call_3`)] },
            { role: `tool`, content: `a` },
            { role: `tool`, content: `b` },
        ]);

        expect(signatures(sent[1])).toEqual([SKIPPED_SIGNATURE]);
        // A parallel step is signed on its first call only, as Google signs it.
        expect(signatures(sent[3])).toEqual([SKIPPED_SIGNATURE, undefined]);
    });

    it("keeps a signature that survived, and whatever else rides beside it", () => {
        const kept = { id: `call_1`, extra_content: { google: { thought_signature: `real`, other: `x` } } };
        const body = JSON.stringify({ messages: [{ role: `assistant`, tool_calls: [kept] }] });

        expect(withSignedToolCalls(body)).toBe(body);
        const blank = rewrite([{ role: `assistant`, tool_calls: [{ id: `call_1`, extra_content: { google: { thought_signature: ``, other: `x` } } }] }]);
        expect(blank[0]?.tool_calls?.[0]?.extra_content?.google).toEqual({ thought_signature: SKIPPED_SIGNATURE, other: `x` });
    });

    it("leaves a body with no tool calls, and one it can't read, byte-identical", () => {
        const plain = JSON.stringify({ model: `auto`, messages: [{ role: `user`, content: `hi` }, { role: `assistant`, content: `hello` }] });

        expect(withSignedToolCalls(plain)).toBe(plain);
        expect(withSignedToolCalls(`not json`)).toBe(`not json`);
        expect(withSignedToolCalls(`{"messages":"nope"}`)).toBe(`{"messages":"nope"}`);
    });

    it("is Google's surface alone", () => {
        expect(googleCompatible(`https://generativelanguage.googleapis.com/v1beta/openai`)).toBe(true);
        expect(googleCompatible(`https://generativelanguage.googleapis.com/v1beta/openai/`)).toBe(true);
        expect(googleCompatible(`https://api.openai.com/v1`)).toBe(false);
    });
});
