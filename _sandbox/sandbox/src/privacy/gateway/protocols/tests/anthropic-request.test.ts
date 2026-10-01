import { shieldRequest } from "../index.js";
import type { Json, JsonObject } from "../walk.js";
import { at, deepFreeze, DOCUMENT_TEXT, fakeShield, IMAGE_TEXT, MASKED_IMAGE, NOTE } from "./fake-shield.testing.js";

// The Messages API request as Claude Code sends it. Every place a person's data can sit in the conversation must come
// out masked, and every byte the provider signs or the harness owns must come out untouched.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PDF = "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSL0ZpbHRlci9GbGF0ZURlY29kZT4+";

const TOOLS = [
    {
        name: "Bash",
        description: "Run a command for Jan Kowalski's project",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
];

const THINKING = {
    type: "thinking",
    thinking: "The user is Jan Kowalski; I should write to jan.kowalski@example.pl.",
    signature: "EqQBCkYIBxgCKkDo2mN0Z3Rva2VuLXNpZ25hdHVyZQ==",
};

// A turn the way Claude Code builds one: a cached system prompt, a user message with a reminder and a pasted image,
// an assistant turn that thought and called a tool, and the tool's result with a PDF in it.
const claudeCodeRequest = (): JsonObject =>
    deepFreeze({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 32_000,
        stream: true,
        metadata: { user_id: "user_jan.kowalski@example.pl_account" },
        system: [
            { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
            { type: "text", text: "The user's name is Jan Kowalski.", cache_control: { type: "ephemeral" } },
        ],
        tools: TOOLS,
        tool_choice: { type: "auto" },
        thinking: { type: "enabled", budget_tokens: 31_999 },
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "<system-reminder>Contact: jan.kowalski@example.pl</system-reminder>" },
                    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG }, cache_control: { type: "ephemeral" } },
                    {
                        type: "text",
                        text: "Send the invoice to Jan Kowalski, account PL61109010140000071219812874.",
                        cache_control: { type: "ephemeral" },
                    },
                ],
            },
            {
                role: "assistant",
                content: [
                    THINKING,
                    {
                        type: "redacted_thinking",
                        data: "EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpPkNRj2YfWXGmKDxH4mPnZ5sQ7vB5URj2pLmN8vMd",
                    },
                    { type: "text", text: "I'll write to Jan Kowalski." },
                    {
                        type: "tool_use",
                        id: "toolu_01A09q90qw90lq917835lq9",
                        name: "Bash",
                        input: { command: "echo 'Jan Kowalski' > /tmp/who", "Jan Kowalski": ["Jan Kowalski", 3, null] },
                    },
                ],
            },
            {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "toolu_01A09q90qw90lq917835lq9",
                        content: [
                            { type: "text", text: "wrote Jan Kowalski" },
                            { type: "image", source: { type: "url", url: "https://example.com/jan.png" } },
                            {
                                type: "document",
                                source: { type: "base64", media_type: "application/pdf", data: PDF },
                                title: "Jan Kowalski invoice",
                                context: "for Jan Kowalski",
                                citations: { enabled: true },
                                cache_control: { type: "ephemeral" },
                            },
                        ],
                    },
                    { type: "tool_result", tool_use_id: "toolu_02", content: "Jan Kowalski", is_error: false },
                    { type: "text", text: "Thanks" },
                ],
            },
        ],
    });

const blocksOf = (body: Json, message: number): Json | undefined => at(body, "messages", message, "content");

describe("shielding an Anthropic Messages request", () => {
    test("every content location is masked and the note closes the system prompt", async () => {
        const body = claudeCodeRequest();
        const shield = fakeShield();
        const shielded = await shieldRequest("anthropic", body, shield);
        expect(at(shielded, "system")).toEqual([
            { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
            { type: "text", text: "The user's name is ⟦PERSON_1⟧.", cache_control: { type: "ephemeral" } },
            // After the last cache breakpoint, so the cached prefix is the same with masking on or off.
            { type: "text", text: NOTE },
        ]);
        expect(blocksOf(shielded, 0)).toEqual([
            { type: "text", text: "<system-reminder>Contact: ⟦EMAIL_1⟧</system-reminder>" },
            { type: "text", text: IMAGE_TEXT, cache_control: { type: "ephemeral" } },
            { type: "text", text: "Send the invoice to ⟦PERSON_1⟧, account ⟦BANK_ACCOUNT_3⟧.", cache_control: { type: "ephemeral" } },
        ]);
        expect([at(shielded, "messages", 1, "content", 2), at(shielded, "messages", 1, "content", 3)]).toEqual([
            { type: "text", text: "I'll write to ⟦PERSON_1⟧." },
            // Values masked at any depth; the key is the harness's structure and stays.
            {
                type: "tool_use",
                id: "toolu_01A09q90qw90lq917835lq9",
                name: "Bash",
                input: { command: "echo '⟦PERSON_1⟧' > /tmp/who", "Jan Kowalski": ["⟦PERSON_1⟧", 3, null] },
            },
        ]);
        expect(blocksOf(shielded, 2)).toEqual([
            {
                type: "tool_result",
                tool_use_id: "toolu_01A09q90qw90lq917835lq9",
                content: [
                    { type: "text", text: "wrote ⟦PERSON_1⟧" },
                    { type: "text", text: IMAGE_TEXT },
                    {
                        type: "document",
                        source: { type: "text", media_type: "text/plain", data: DOCUMENT_TEXT },
                        title: "⟦PERSON_1⟧ invoice",
                        context: "for ⟦PERSON_1⟧",
                        citations: { enabled: true },
                        cache_control: { type: "ephemeral" },
                    },
                ],
            },
            { type: "tool_result", tool_use_id: "toolu_02", content: "⟦PERSON_1⟧", is_error: false },
            { type: "text", text: "Thanks" },
        ]);
        expect(shield.images).toEqual([
            { mediaType: "image/png", data: PNG },
            { mediaType: "url", data: "https://example.com/jan.png" },
        ]);
        expect(shield.documents).toEqual([{ mediaType: "application/pdf", data: PDF }]);
    });

    test("signed thinking, tools and request settings are passed through untouched", async () => {
        // A changed byte in a thinking block fails its signature and the provider refuses the whole request.
        const body = claudeCodeRequest();
        const shielded = await shieldRequest("anthropic", body, fakeShield());
        const thinking = at(shielded, "messages", 1, "content", 0);
        expect(thinking).toBe(at(body, "messages", 1, "content", 0));
        expect(at(shielded, "messages", 1, "content", 1)).toBe(at(body, "messages", 1, "content", 1));
        expect(JSON.stringify(thinking)).toBe(JSON.stringify(THINKING));
        for (const key of ["tools", "tool_choice", "metadata", "model", "max_tokens", "thinking", "stream"]) {
            expect(at(shielded, key)).toBe(body[key]);
        }
    });

    test("the input is never mutated and a new body comes back", async () => {
        // The fixture is frozen all the way down, so an in-place edit would have thrown.
        const body = claudeCodeRequest();
        const before = JSON.stringify(body);
        const shielded = await shieldRequest("anthropic", body, fakeShield());
        expect(shielded).not.toBe(body);
        expect(JSON.stringify(body)).toBe(before);
    });

    test("images and documents the shield keeps go as they came", async () => {
        const body = claudeCodeRequest();
        const shielded = await shieldRequest("anthropic", body, fakeShield({ keep: true }));
        expect(at(shielded, "messages", 0, "content", 1)).toBe(at(body, "messages", 0, "content", 1));
        const result = at(shielded, "messages", 2, "content", 0, "content");
        expect(at(result, 1)).toEqual({ type: "image", source: { type: "url", url: "https://example.com/jan.png" } });
        // A kept document still has its title and context masked: they are text the model reads.
        expect(at(result, 2, "source")).toEqual({ type: "base64", media_type: "application/pdf", data: PDF });
        expect(at(result, 2, "title")).toBe("⟦PERSON_1⟧ invoice");
    });

    test("an image the shield paints over goes as that picture, inline, its cache breakpoint kept", async () => {
        const body = claudeCodeRequest();
        const shielded = await shieldRequest("anthropic", body, fakeShield({ paint: true }));
        expect(at(shielded, "messages", 0, "content", 1)).toEqual({
            type: "image",
            source: { type: "base64", media_type: MASKED_IMAGE.mediaType, data: MASKED_IMAGE.data },
            cache_control: { type: "ephemeral" },
        });
        // One named by address goes inline too: what was checked is what is sent.
        expect(at(shielded, "messages", 2, "content", 0, "content", 1)).toEqual({
            type: "image",
            source: { type: "base64", media_type: MASKED_IMAGE.mediaType, data: MASKED_IMAGE.data },
        });
    });

    test("the note goes where each system shape allows", async () => {
        const shield = fakeShield();
        const asString = await shieldRequest("anthropic", { system: "Assist Jan Kowalski.", messages: [] }, shield);
        expect(at(asString, "system")).toBe(`Assist ⟦PERSON_1⟧.\n\n${NOTE}`);
        const absent = await shieldRequest("anthropic", { messages: [] }, shield);
        expect(at(absent, "system")).toBe(NOTE);
        const empty = await shieldRequest("anthropic", { system: "", messages: [] }, shield);
        expect(at(empty, "system")).toBe(NOTE);
        // With masking off there is no note, and nothing is added.
        const noNote = await shieldRequest("anthropic", { messages: [] }, fakeShield({ note: undefined }));
        expect(noNote).toEqual({ messages: [] });
        const unchanged = await shieldRequest("anthropic", { system: [{ type: "text", text: "x" }], messages: [] }, fakeShield({ note: undefined }));
        expect(at(unchanged, "system")).toEqual([{ type: "text", text: "x" }]);
    });

    test("documents in every source shape are read or masked", async () => {
        const shield = fakeShield();
        const body = deepFreeze({
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "document", source: { type: "text", media_type: "text/plain", data: "Jan Kowalski's notes" }, title: "Notes" },
                        {
                            type: "document",
                            source: {
                                type: "content",
                                content: [
                                    { type: "text", text: "Jan Kowalski" },
                                    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG } },
                                ],
                            },
                        },
                        { type: "document", source: { type: "url", url: "https://example.com/jan.pdf" }, citations: { enabled: true } },
                        { type: "document", source: { type: "file", file_id: "file_011CNha8iCJcU1wXNR6q4V8w" } },
                        {
                            type: "search_result",
                            source: "https://example.com/jan",
                            title: "Jan Kowalski profile",
                            content: [{ type: "text", text: "Jan Kowalski lives here" }],
                        },
                    ],
                },
            ],
        });
        const blocks = blocksOf(await shieldRequest("anthropic", body, shield), 0);
        expect(blocks).toEqual([
            { type: "document", source: { type: "text", media_type: "text/plain", data: "⟦PERSON_1⟧'s notes" }, title: "Notes" },
            {
                type: "document",
                source: {
                    type: "content",
                    content: [
                        { type: "text", text: "⟦PERSON_1⟧" },
                        { type: "text", text: IMAGE_TEXT },
                    ],
                },
            },
            { type: "document", source: { type: "text", media_type: "text/plain", data: DOCUMENT_TEXT }, citations: { enabled: true } },
            { type: "document", source: { type: "file", file_id: "file_011CNha8iCJcU1wXNR6q4V8w" } },
            {
                type: "search_result",
                source: "https://example.com/jan",
                title: "⟦PERSON_1⟧ profile",
                content: [{ type: "text", text: "⟦PERSON_1⟧ lives here" }],
            },
        ]);
        expect(shield.documents).toEqual([{ mediaType: "url", data: "https://example.com/jan.pdf" }]);
    });

    test("server tool calls are masked, the provider's own results and unknown blocks are not", async () => {
        // A web search result carries encrypted content the provider checks; a block type newer than this walker is left
        // whole rather than guessed at.
        const searchResult = {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_01",
            content: [
                {
                    type: "web_search_result",
                    url: "https://example.com",
                    title: "Jan Kowalski",
                    encrypted_content: "EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y",
                },
            ],
        };
        const future = { type: "memory_note", text: "Jan Kowalski" };
        const body = deepFreeze({
            messages: [
                {
                    role: "assistant",
                    content: [
                        { type: "server_tool_use", id: "srvtoolu_01", name: "web_search", input: { query: "Jan Kowalski" } },
                        searchResult,
                        { type: "mcp_tool_use", id: "mcptoolu_01", name: "lookup", server_name: "crm", input: { who: "Jan Kowalski" } },
                        {
                            type: "mcp_tool_result",
                            tool_use_id: "mcptoolu_01",
                            is_error: false,
                            content: [{ type: "text", text: "Jan Kowalski: VIP" }],
                        },
                        future,
                    ],
                },
                { role: "user", content: "Who is Jan Kowalski?" },
            ],
        });
        const shielded = await shieldRequest("anthropic", body, fakeShield());
        const blocks = blocksOf(shielded, 0);
        expect(at(blocks, 0)).toEqual({ type: "server_tool_use", id: "srvtoolu_01", name: "web_search", input: { query: "⟦PERSON_1⟧" } });
        expect(at(blocks, 1)).toBe(searchResult);
        expect(at(blocks, 2)).toEqual({ type: "mcp_tool_use", id: "mcptoolu_01", name: "lookup", server_name: "crm", input: { who: "⟦PERSON_1⟧" } });
        expect(at(blocks, 3)).toEqual({
            type: "mcp_tool_result",
            tool_use_id: "mcptoolu_01",
            is_error: false,
            content: [{ type: "text", text: "⟦PERSON_1⟧: VIP" }],
        });
        expect(at(blocks, 4)).toBe(future);
        expect(blocksOf(shielded, 1)).toBe("Who is ⟦PERSON_1⟧?");
    });

    test("a count_tokens body is shielded the same way", async () => {
        // Counting a masked request is what makes the count match what is then sent.
        const body = { model: "claude-sonnet-4-5", system: "Hi Jan Kowalski", messages: [{ role: "user", content: "Jan Kowalski" }], tools: TOOLS };
        const shielded = await shieldRequest("anthropic", body, fakeShield());
        expect(shielded).toEqual({
            model: "claude-sonnet-4-5",
            system: `Hi ⟦PERSON_1⟧\n\n${NOTE}`,
            messages: [{ role: "user", content: "⟦PERSON_1⟧" }],
            tools: TOOLS,
        });
    });
});
