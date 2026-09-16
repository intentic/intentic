import { describe, expect, it } from "vitest";
import { withImagesInUserMessages } from "./trial-images.js";

// What's pinned here is the shape the upstream refuses: an image part outside a `user` message, which is exactly what
// the harness's translator emits for a tool result carrying a screenshot.

const IMAGE = { type: `image_url`, image_url: { url: `data:image/png;base64,AAAA` } };

interface Message {
    readonly role: string;
    readonly content: unknown;
    readonly tool_call_id?: string;
}

interface Part {
    readonly type: string;
    readonly text?: string;
}

// Indexing is checked, so a missing message fails as itself rather than as a confusing property read.
const at = <T>(items: readonly T[], index: number): T => {
    const item = items[index];
    if (item === undefined) {
        throw new Error(`nothing at index ${index} of ${items.length}`);
    }
    return item;
};

const rewrite = (messages: readonly unknown[]): Message[] =>
    (JSON.parse(withImagesInUserMessages(JSON.stringify({ model: `auto`, messages }))) as { messages: Message[] }).messages;

const partsOf = (message: Message): Part[] => (Array.isArray(message.content) ? (message.content as Part[]) : []);

const imagesIn = (message: Message): Part[] => partsOf(message).filter((part) => part.type === `image_url`);

const toolCall = { role: `assistant`, content: ``, tool_calls: [{ id: `call_1`, type: `function`, function: { name: `Read`, arguments: `{}` } }] };

describe("images bound for the trial upstream", () => {
    it("moves a tool result's image into a user message that follows it", () => {
        const messages = rewrite([
            { role: `user`, content: [{ type: `text`, text: `what is in /tmp/shot.png?` }] },
            toolCall,
            { role: `tool`, tool_call_id: `call_1`, content: [IMAGE] },
        ]);

        expect(messages.map((message) => message.role)).toEqual([`user`, `assistant`, `tool`, `user`]);
        // The tool result keeps its place in the tool-call pairing, and says where its image went.
        expect(at(messages, 2).content).toBe(`[image moved to the message below]`);
        expect(imagesIn(at(messages, 3))).toHaveLength(1);
        expect(at(partsOf(at(messages, 3)), 0).text).toBe(`Image returned by tool call call_1:`);
    });

    it("keeps the text a tool result returned alongside its image", () => {
        const messages = rewrite([
            toolCall,
            { role: `tool`, tool_call_id: `call_1`, content: [{ type: `text`, text: `Read 1 image (48x48).` }, IMAGE] },
        ]);

        expect(at(messages, 1).content).toBe(`Read 1 image (48x48).\n\n[image moved to the message below]`);
        expect(imagesIn(at(messages, 2))).toHaveLength(1);
    });

    it("waits out a run of tool results rather than splitting it from its tool call", () => {
        const messages = rewrite([
            toolCall,
            { role: `tool`, tool_call_id: `call_1`, content: [IMAGE] },
            { role: `tool`, tool_call_id: `call_2`, content: [IMAGE] },
            { role: `assistant`, content: [{ type: `text`, text: `both read` }] },
        ]);

        // Both images ride one user message after the last tool result: a `user` message between them would break the
        // adjacency OpenAI requires of tool results.
        expect(messages.map((message) => message.role)).toEqual([`assistant`, `tool`, `tool`, `user`, `assistant`]);
        expect(imagesIn(at(messages, 3))).toHaveLength(2);
        expect(at(partsOf(at(messages, 3)), 2).text).toBe(`Image returned by tool call call_2:`);
    });

    it("leaves an image that already rides a user message alone", () => {
        const body = JSON.stringify({ model: `auto`, messages: [{ role: `user`, content: [{ type: `text`, text: `hi` }, IMAGE] }] });

        // Byte-identical, not merely equivalent: a body with nothing to move is never re-serialized.
        expect(withImagesInUserMessages(body)).toBe(body);
    });

    it("passes through a body it cannot read", () => {
        expect(withImagesInUserMessages(`not json`)).toBe(`not json`);
        expect(withImagesInUserMessages(`{"model":"auto"}`)).toBe(`{"model":"auto"}`);
        expect(withImagesInUserMessages(`[]`)).toBe(`[]`);
    });

    it("keeps every other field of the request and of the message it rewrites", () => {
        const body = JSON.stringify({
            model: `auto`,
            stream: true,
            tools: [{ type: `function` }],
            messages: [{ role: `tool`, tool_call_id: `call_1`, cache_control: { type: `ephemeral` }, content: [IMAGE] }],
        });

        const parsed = JSON.parse(withImagesInUserMessages(body)) as { stream: boolean; tools: unknown[]; messages: Message[] };
        expect(parsed.stream).toBe(true);
        expect(parsed.tools).toHaveLength(1);
        expect(at(parsed.messages, 0)).toMatchObject({ tool_call_id: `call_1`, cache_control: { type: `ephemeral` } });
    });
});
