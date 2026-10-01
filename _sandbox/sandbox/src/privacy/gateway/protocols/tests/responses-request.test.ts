import { shieldRequest } from "../index.js";
import type { JsonObject } from "../walk.js";
import { at, deepFreeze, DOCUMENT_TEXT, fakeShield, IMAGE_TEXT, MASKED_IMAGE, NOTE } from "./fake-shield.testing.js";

// The Responses API request as Codex sends it. Every item that carries what the user, the model or a tool wrote must
// come out masked; reasoning items hold the provider's encrypted state and must come out exactly as they went in.

const PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PDF = "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSL0ZpbHRlci9GbGF0ZURlY29kZT4+";

const TOOLS = [
    {
        type: "function",
        name: "shell",
        description: "Runs a shell command for Jan Kowalski",
        strict: false,
        parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } } } },
    },
    { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark", definition: "start: patch" } },
];

const REASONING = {
    type: "reasoning",
    id: "rs_68c1a2b3c4d5e6f7",
    summary: [{ type: "summary_text", text: "**Writing to ⟦PERSON_1⟧** Jan Kowalski" }],
    content: null,
    encrypted_content: "gAAAAABoz1mAbcdefJanKowalski0123456789==",
};

const codexRequest = (): JsonObject =>
    deepFreeze({
        model: "gpt-5-codex",
        instructions: "You are Codex, based on GPT-5. You are working for Jan Kowalski.",
        tools: TOOLS,
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning: { effort: "medium", summary: "auto" },
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "019a0000-1111-7222-8333-444455556666",
        input: [
            {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: "<permissions instructions>Jan Kowalski's sandbox</permissions instructions>" }],
            },
            {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/home/jan</cwd>\n</environment_context>" }],
            },
            {
                type: "message",
                role: "user",
                content: [
                    { type: "input_text", text: "Email Jan Kowalski at jan.kowalski@example.pl" },
                    { type: "input_image", image_url: PNG_URL, detail: "auto" },
                    { type: "input_image", image_url: "https://example.com/jan.png" },
                    { type: "input_image", file_id: "file-AbC123" },
                    { type: "input_file", file_data: `data:application/pdf;base64,${PDF}`, filename: "Jan Kowalski invoice.pdf" },
                    { type: "input_file", file_data: PDF, filename: "raw.pdf" },
                    { type: "input_file", file_url: "https://example.com/jan.pdf" },
                ],
            },
            REASONING,
            {
                type: "message",
                role: "assistant",
                id: "msg_1",
                status: "completed",
                content: [
                    { type: "output_text", text: "Writing to Jan Kowalski.", annotations: [] },
                    { type: "refusal", refusal: "Not Jan Kowalski" },
                ],
            },
            {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1234567890",
                name: "shell",
                arguments: '{"command":["bash","-lc","echo Jan Kowalski"],"workdir":"/home/jan"}',
            },
            { type: "function_call_output", call_id: "call_1234567890", output: "Exit code: 0\nOutput:\nJan Kowalski\n" },
            {
                type: "function_call_output",
                call_id: "call_2",
                output: [
                    { type: "input_text", text: "Jan Kowalski" },
                    { type: "input_image", image_url: PNG_URL },
                ],
            },
            {
                type: "custom_tool_call",
                id: "ctc_1",
                call_id: "call_3",
                name: "apply_patch",
                input: "*** Begin Patch\n*** Add File: a.txt\n+Jan Kowalski\n*** End Patch",
            },
            { type: "custom_tool_call_output", call_id: "call_3", output: "Done for Jan Kowalski" },
            {
                type: "local_shell_call",
                id: "lsh_1",
                call_id: "call_4",
                status: "completed",
                action: {
                    type: "exec",
                    command: ["echo", "Jan Kowalski"],
                    env: { WHO: "Jan Kowalski" },
                    working_directory: "/home/Jan Kowalski",
                    timeout_ms: 1000,
                },
            },
            { type: "local_shell_call_output", call_id: "call_4", output: "Jan Kowalski" },
            {
                type: "mcp_call",
                id: "mcp_1",
                server_label: "crm",
                name: "find",
                arguments: '{"who":"Jan Kowalski"}',
                output: "Jan Kowalski: VIP",
                error: null,
            },
            { role: "user", content: "Thanks, Jan Kowalski" },
            { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "Jan Kowalski" } },
            { type: "item_reference", id: "msg_0" },
            { type: "compaction", encrypted_content: "gAAAAABJanKowalski" },
        ],
    });

describe("shielding a Responses request", () => {
    test("every item that carries conversation is masked, ids and call ids are not", async () => {
        const shield = fakeShield();
        const shielded = await shieldRequest("responses", codexRequest(), shield);
        expect(at(shielded, "instructions")).toBe(`You are Codex, based on GPT-5. You are working for ⟦PERSON_1⟧.\n\n${NOTE}`);
        expect(at(shielded, "input", 0, "content", 0, "text")).toBe("<permissions instructions>⟦PERSON_1⟧'s sandbox</permissions instructions>");
        expect(at(shielded, "input", 2, "content")).toEqual([
            { type: "input_text", text: "Email ⟦PERSON_1⟧ at ⟦EMAIL_1⟧" },
            { type: "input_text", text: IMAGE_TEXT },
            { type: "input_text", text: IMAGE_TEXT },
            // An image the provider already holds by id is nothing the shield can read.
            { type: "input_image", file_id: "file-AbC123" },
            { type: "input_text", text: DOCUMENT_TEXT },
            { type: "input_text", text: DOCUMENT_TEXT },
            { type: "input_text", text: DOCUMENT_TEXT },
        ]);
        expect(at(shielded, "input", 4, "content")).toEqual([
            { type: "output_text", text: "Writing to ⟦PERSON_1⟧.", annotations: [] },
            { type: "refusal", refusal: "Not Jan Kowalski" },
        ]);
        expect(at(shielded, "input", 5)).toEqual({
            type: "function_call",
            id: "fc_1",
            call_id: "call_1234567890",
            name: "shell",
            arguments: '{"command":["bash","-lc","echo ⟦PERSON_1⟧"],"workdir":"/home/jan"}',
        });
        expect(at(shielded, "input", 6, "output")).toBe("Exit code: 0\nOutput:\n⟦PERSON_1⟧\n");
        expect(at(shielded, "input", 7, "output")).toEqual([
            { type: "input_text", text: "⟦PERSON_1⟧" },
            { type: "input_text", text: IMAGE_TEXT },
        ]);
        expect(at(shielded, "input", 8, "input")).toBe("*** Begin Patch\n*** Add File: a.txt\n+⟦PERSON_1⟧\n*** End Patch");
        expect(at(shielded, "input", 9, "output")).toBe("Done for ⟦PERSON_1⟧");
        expect(at(shielded, "input", 10, "action")).toEqual({
            type: "exec",
            command: ["echo", "⟦PERSON_1⟧"],
            env: { WHO: "⟦PERSON_1⟧" },
            working_directory: "/home/⟦PERSON_1⟧",
            timeout_ms: 1000,
        });
        expect(at(shielded, "input", 11, "output")).toBe("⟦PERSON_1⟧");
        expect(at(shielded, "input", 12)).toEqual({
            type: "mcp_call",
            id: "mcp_1",
            server_label: "crm",
            name: "find",
            arguments: '{"who":"⟦PERSON_1⟧"}',
            output: "⟦PERSON_1⟧: VIP",
            error: null,
        });
        expect(at(shielded, "input", 13)).toEqual({ role: "user", content: "Thanks, ⟦PERSON_1⟧" });
        expect(shield.images.map(({ mediaType }) => mediaType)).toEqual(["image/png", "url", "image/png"]);
        expect(shield.documents).toEqual([
            { mediaType: "application/pdf", data: PDF },
            { mediaType: "application/pdf", data: PDF },
            { mediaType: "url", data: "https://example.com/jan.pdf" },
        ]);
    });

    test("reasoning, provider-run calls, references and settings pass untouched", async () => {
        // Encrypted reasoning that changed by a byte is refused; the summary's token stays a token for the same reason.
        const body = codexRequest();
        const shielded = await shieldRequest("responses", body, fakeShield());
        expect(at(shielded, "input", 3)).toBe(REASONING);
        for (const index of [14, 15, 16]) {
            expect(at(shielded, "input", index)).toBe(at(body, "input", index));
        }
        for (const key of ["tools", "tool_choice", "reasoning", "include", "prompt_cache_key", "model", "store"]) {
            expect(at(shielded, key)).toBe(body[key]);
        }
    });

    test("the input is never mutated and a new body comes back", async () => {
        const body = codexRequest();
        const before = JSON.stringify(body);
        expect(await shieldRequest("responses", body, fakeShield())).not.toBe(body);
        expect(JSON.stringify(body)).toBe(before);
    });

    test("an image the shield paints over goes as that picture's data URL, its detail kept", async () => {
        const shielded = await shieldRequest("responses", codexRequest(), fakeShield({ paint: true }));
        const painted = `data:${MASKED_IMAGE.mediaType};base64,${MASKED_IMAGE.data}`;
        expect(at(shielded, "input", 2, "content", 1)).toEqual({ type: "input_image", image_url: painted, detail: "auto" });
        expect(at(shielded, "input", 2, "content", 2)).toEqual({ type: "input_image", image_url: painted });
        // Named only by a file id, an image is the provider's own copy and goes as it was.
        expect(at(shielded, "input", 2, "content", 3)).toEqual({ type: "input_image", file_id: "file-AbC123" });
    });

    test("files the shield keeps go as they came, with their names masked", async () => {
        const shielded = await shieldRequest("responses", codexRequest(), fakeShield({ keep: true }));
        expect(at(shielded, "input", 2, "content", 1)).toEqual({ type: "input_image", image_url: PNG_URL, detail: "auto" });
        expect(at(shielded, "input", 2, "content", 4)).toEqual({
            type: "input_file",
            file_data: `data:application/pdf;base64,${PDF}`,
            filename: "⟦PERSON_1⟧ invoice.pdf",
        });
    });

    test("the note goes where each instructions shape allows", async () => {
        expect(at(await shieldRequest("responses", { input: "Hi Jan Kowalski" }, fakeShield()), "instructions")).toBe(NOTE);
        expect(await shieldRequest("responses", { input: "Hi Jan Kowalski" }, fakeShield())).toEqual({ input: "Hi ⟦PERSON_1⟧", instructions: NOTE });
        expect(await shieldRequest("responses", { instructions: "Be brief.", input: "Hi" }, fakeShield({ note: undefined }))).toEqual({
            instructions: "Be brief.",
            input: "Hi",
        });
        const asItems = await shieldRequest(
            "responses",
            { instructions: [{ role: "developer", content: "For Jan Kowalski" }], input: [] },
            fakeShield(),
        );
        expect(at(asItems, "instructions")).toEqual([
            { role: "developer", content: "For ⟦PERSON_1⟧" },
            { type: "message", role: "developer", content: NOTE },
        ]);
    });

    test("the shell and patch tools of newer models are masked too", async () => {
        const body = {
            input: [
                {
                    type: "shell_call",
                    id: "sh_1",
                    call_id: "call_9",
                    action: { commands: ["cat /home/Jan Kowalski/notes"], timeout_ms: 1000 },
                    status: "completed",
                },
                {
                    type: "shell_call_output",
                    call_id: "call_9",
                    output: [{ stdout: "Jan Kowalski", stderr: "", outcome: { type: "exit", exit_code: 0 } }],
                },
                {
                    type: "apply_patch_call",
                    id: "ap_1",
                    call_id: "call_10",
                    operation: { type: "update_file", path: "Jan Kowalski.md", diff: "+Jan Kowalski" },
                    status: "completed",
                },
                { type: "apply_patch_call_output", call_id: "call_10", status: "completed", output: "Patched Jan Kowalski.md" },
            ],
        };
        const shielded = await shieldRequest("responses", body, fakeShield({ note: undefined }));
        expect(at(shielded, "input")).toEqual([
            {
                type: "shell_call",
                id: "sh_1",
                call_id: "call_9",
                action: { commands: ["cat /home/⟦PERSON_1⟧/notes"], timeout_ms: 1000 },
                status: "completed",
            },
            { type: "shell_call_output", call_id: "call_9", output: [{ stdout: "⟦PERSON_1⟧", stderr: "", outcome: { type: "exit", exit_code: 0 } }] },
            {
                type: "apply_patch_call",
                id: "ap_1",
                call_id: "call_10",
                operation: { type: "update_file", path: "⟦PERSON_1⟧.md", diff: "+⟦PERSON_1⟧" },
                status: "completed",
            },
            { type: "apply_patch_call_output", call_id: "call_10", status: "completed", output: "Patched ⟦PERSON_1⟧.md" },
        ]);
    });
});
