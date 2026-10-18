import { compactAnthropicTools } from "./anthropic-tools.js";
import { isList, isRecord, type Json } from "./walk.js";

// What leaves an Anthropic request's tool list: each schema's root dialect line, and nothing else.

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const tool = (name: string, schema: Json): Json => ({ name, description: `${name} things`, input_schema: schema });

test("each tool's root dialect line goes, and the rest of the tool stays where it was", () => {
    const body = {
        model: "claude-opus-5",
        tools: [
            tool("open", { $schema: DIALECT, type: "object", properties: { url: { type: "string" } }, required: ["url"] }),
            { name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } } }, cache_control: { type: "ephemeral" } },
        ],
        messages: [],
    };

    const compacted = compactAnthropicTools(body);

    expect(JSON.stringify(compacted)).toBe(JSON.stringify(body).replace(`"$schema":"${DIALECT}",`, ""));
    // The tool that carried none is the very same object, so its bytes, cache breakpoint included, cannot move.
    expect(isRecord(compacted) && isList(compacted["tools"]) ? compacted["tools"][1] : undefined).toBe(body.tools[1]);
});

test("a parameter that happens to be called $schema is a parameter, and stays", () => {
    const body = { tools: [tool("validate", { type: "object", properties: { $schema: { type: "string" }, document: { type: "object" } } })] };

    expect(compactAnthropicTools(body)).toBe(body);
});

test("a body with no tools, or none carrying the line, is returned as it came", () => {
    const plain = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const clean = { tools: [tool("open", { type: "object" })] };

    expect(compactAnthropicTools(plain)).toBe(plain);
    expect(compactAnthropicTools(clean)).toBe(clean);
});

test("the same request compacts to the same bytes every time, so the provider's cache holds", () => {
    const body = { tools: [tool("a", { $schema: DIALECT, type: "object" }), tool("b", { $schema: DIALECT, type: "object" })] };

    expect(JSON.stringify(compactAnthropicTools(body))).toBe(JSON.stringify(compactAnthropicTools(structuredClone(body))));
});
