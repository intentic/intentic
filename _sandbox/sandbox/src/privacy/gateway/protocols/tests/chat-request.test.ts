import { shieldRequest } from "../index.js";
import type { JsonObject } from "../walk.js";
import { at, deepFreeze, DOCUMENT_TEXT, fakeShield, IMAGE_TEXT, MASKED_IMAGE, NOTE } from "./fake-shield.testing.js";

// Chat Completions as OpenCode sends it to an OpenAI-compatible provider: every role's content and the assistant's
// call arguments must come out masked, the provider's reasoning and the tool definitions untouched.

const PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PDF = "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSL0ZpbHRlci9GbGF0ZURlY29kZT4+";

const TOOLS = [
    {
        type: "function",
        function: { name: "bash", description: "Run for Jan Kowalski", parameters: { type: "object", properties: { command: { type: "string" } } } },
    },
];

const openCodeRequest = (): JsonObject =>
    deepFreeze({
        model: "deepseek-chat",
        stream: true,
        stream_options: { include_usage: true },
        tools: TOOLS,
        tool_choice: "auto",
        messages: [
            { role: "system", content: "You are opencode. The user is Jan Kowalski." },
            {
                role: "user",
                content: [
                    { type: "text", text: "Mail Jan Kowalski at jan.kowalski@example.pl" },
                    { type: "image_url", image_url: { url: PNG_URL, detail: "auto" } },
                    { type: "image_url", image_url: { url: "https://example.com/jan.png" } },
                    { type: "file", file: { file_data: `data:application/pdf;base64,${PDF}`, filename: "Jan Kowalski.pdf" } },
                    { type: "file", file: { file_id: "file-abc" } },
                    { type: "input_audio", input_audio: { data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", format: "wav" } },
                ],
            },
            {
                role: "assistant",
                content: "Writing to Jan Kowalski.",
                reasoning_content: "The user Jan Kowalski wants mail.",
                tool_calls: [{ id: "call_00_abc", type: "function", function: { name: "bash", arguments: '{"command":"echo Jan Kowalski"}' } }],
            },
            { role: "tool", tool_call_id: "call_00_abc", content: "Jan Kowalski" },
            { role: "tool", tool_call_id: "call_01", content: [{ type: "text", text: "Jan Kowalski again" }] },
            { role: "user", content: "Thanks Jan Kowalski" },
        ],
    });

describe("shielding a Chat Completions request", () => {
    test("every role's content and the assistant's call arguments are masked", async () => {
        const shield = fakeShield();
        const shielded = await shieldRequest("chat", openCodeRequest(), shield);
        expect(at(shielded, "messages", 0)).toEqual({ role: "system", content: `You are opencode. The user is ⟦PERSON_1⟧.\n\n${NOTE}` });
        expect(at(shielded, "messages", 1, "content")).toEqual([
            { type: "text", text: "Mail ⟦PERSON_1⟧ at ⟦EMAIL_1⟧" },
            { type: "text", text: IMAGE_TEXT },
            { type: "text", text: IMAGE_TEXT },
            { type: "text", text: DOCUMENT_TEXT },
            { type: "file", file: { file_id: "file-abc" } },
            { type: "input_audio", input_audio: { data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", format: "wav" } },
        ]);
        expect(at(shielded, "messages", 2)).toEqual({
            role: "assistant",
            content: "Writing to ⟦PERSON_1⟧.",
            // The provider's own reasoning, sent back as it gave it.
            reasoning_content: "The user Jan Kowalski wants mail.",
            tool_calls: [{ id: "call_00_abc", type: "function", function: { name: "bash", arguments: '{"command":"echo ⟦PERSON_1⟧"}' } }],
        });
        expect(at(shielded, "messages", 3, "content")).toBe("⟦PERSON_1⟧");
        expect(at(shielded, "messages", 4, "content")).toEqual([{ type: "text", text: "⟦PERSON_1⟧ again" }]);
        expect(at(shielded, "messages", 5, "content")).toBe("Thanks ⟦PERSON_1⟧");
        expect(shield.images).toHaveLength(2);
        expect(shield.images[1]).toEqual({ mediaType: "url", data: "https://example.com/jan.png" });
        expect(shield.documents).toEqual([{ mediaType: "application/pdf", data: PDF }]);
    });

    test("tools, settings and the input itself are left alone", async () => {
        const body = openCodeRequest();
        const before = JSON.stringify(body);
        const shielded = await shieldRequest("chat", body, fakeShield());
        expect(shielded).not.toBe(body);
        expect(JSON.stringify(body)).toBe(before);
        for (const key of ["tools", "tool_choice", "stream_options", "model"]) {
            expect(at(shielded, key)).toBe(body[key]);
        }
    });

    test("kept files go as they came, with their names masked", async () => {
        const shielded = await shieldRequest("chat", openCodeRequest(), fakeShield({ keep: true }));
        expect(at(shielded, "messages", 1, "content", 1)).toEqual({ type: "image_url", image_url: { url: PNG_URL, detail: "auto" } });
        expect(at(shielded, "messages", 1, "content", 3)).toEqual({
            type: "file",
            file: { file_data: `data:application/pdf;base64,${PDF}`, filename: "⟦PERSON_1⟧.pdf" },
        });
    });

    test("an image the shield paints over goes as that picture's data URL, its detail kept", async () => {
        const shielded = await shieldRequest("chat", openCodeRequest(), fakeShield({ paint: true }));
        const painted = `data:${MASKED_IMAGE.mediaType};base64,${MASKED_IMAGE.data}`;
        expect(at(shielded, "messages", 1, "content", 1)).toEqual({ type: "image_url", image_url: { url: painted, detail: "auto" } });
        expect(at(shielded, "messages", 1, "content", 2)).toEqual({ type: "image_url", image_url: { url: painted } });
    });

    test("the note joins a leading system or developer message, or becomes one", async () => {
        const shield = fakeShield();
        const developer = await shieldRequest("chat", { messages: [{ role: "developer", content: "Rules" }] }, shield);
        expect(at(developer, "messages")).toEqual([{ role: "developer", content: `Rules\n\n${NOTE}` }]);
        const parts = await shieldRequest("chat", { messages: [{ role: "system", content: [{ type: "text", text: "Rules" }] }] }, shield);
        expect(at(parts, "messages")).toEqual([
            {
                role: "system",
                content: [
                    { type: "text", text: "Rules" },
                    { type: "text", text: NOTE },
                ],
            },
        ]);
        const none = await shieldRequest("chat", { messages: [{ role: "user", content: "Hi" }] }, shield);
        expect(at(none, "messages")).toEqual([
            { role: "system", content: NOTE },
            { role: "user", content: "Hi" },
        ]);
        const off = await shieldRequest("chat", { messages: [{ role: "user", content: "Hi" }] }, fakeShield({ note: undefined }));
        expect(at(off, "messages")).toEqual([{ role: "user", content: "Hi" }]);
    });

    test("the legacy single function_call is masked like tool_calls", async () => {
        const body = { messages: [{ role: "assistant", content: null, function_call: { name: "bash", arguments: '{"who":"Jan Kowalski"}' } }] };
        const shielded = await shieldRequest("chat", body, fakeShield({ note: undefined }));
        expect(at(shielded, "messages", 0)).toEqual({
            role: "assistant",
            content: null,
            function_call: { name: "bash", arguments: '{"who":"⟦PERSON_1⟧"}' },
        });
    });
});
