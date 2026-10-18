import { isList, isRecord, type Json, type JsonObject } from "./walk.js";

// The tool definitions of an Anthropic Messages request, less the one line in each that only a validator reads. Every
// MCP tool built from a zod schema declares its JSON-Schema dialect at the root of its `input_schema`
// (`"$schema": "https://json-schema.org/draft/2020-12/schema"`, about 17 tokens), and every call of a turn sends every
// loaded tool's again. The model reads parameters, not dialects, so it goes.
//
// Only the root's: a `$schema` deeper in is either a nested schema's own (rare) or a parameter that happens to carry the
// name, and the second one must stay. A pure function of the body, so two requests of one conversation still send the
// same bytes and the provider's cache holds; every untouched value is the original object, so nothing else moves.

const DIALECT = "$schema";

const withoutDialect = (schema: JsonObject): JsonObject => {
    if (!(DIALECT in schema)) {
        return schema;
    }
    const { [DIALECT]: _dialect, ...rest } = schema;
    return rest;
};

const compactTool = (tool: Json): Json => {
    if (!isRecord(tool)) {
        return tool;
    }
    const schema = tool["input_schema"];
    if (!isRecord(schema)) {
        return tool;
    }
    const compacted = withoutDialect(schema);
    // Spread keeps the key where it was, so the tool's own bytes move only by what was removed.
    return compacted === schema ? tool : { ...tool, input_schema: compacted };
};

// The body with each tool's root dialect line removed; the body itself when no tool carried one.
export const compactAnthropicTools = (body: Json): Json => {
    if (!isRecord(body) || !isList(body["tools"])) {
        return body;
    }
    const tools = body["tools"];
    const compacted = tools.map(compactTool);
    return compacted.every((tool, index) => tool === tools[index]) ? body : { ...body, tools: compacted };
};
