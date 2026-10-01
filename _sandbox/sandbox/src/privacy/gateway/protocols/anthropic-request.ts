import type { RequestShield, ShieldBinary } from "../shield-types.js";
import { isList, isRecord, isText, type Json, type JsonObject, mapAll, maskField, maskStrings, maskText, patch, typeOf, withNote } from "./walk.js";

// The Anthropic Messages API as Claude Code sends it (`/v1/messages`, `/v1/messages/count_tokens`). Only `system` and
// `messages` carry conversation; `tools`, `tool_choice`, `metadata` and the rest are the harness's own and go as sent.
// Thinking blocks are signed by the provider, so they go back byte for byte or the request is refused.

type Walk = (value: Json) => Promise<Json>;

// Blocks the walk never opens: signed thinking, results the provider produced itself, and anything newer than this file.
const UNTOUCHED: ReadonlySet<string> = new Set([
    "thinking",
    "redacted_thinking",
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "container_upload",
]);

// `{type: "text", text}` in place of a binary block, carrying its cache breakpoint so the prompt cache keeps its shape.
const textBlock = (block: JsonObject, text: string): JsonObject => {
    const cacheControl = block["cache_control"];
    return cacheControl === undefined ? { type: "text", text } : { type: "text", text, cache_control: cacheControl };
};

// `content` that is a string or a list of blocks, as tool results and search results hold it.
const walkContent = async (content: Json | undefined, shield: RequestShield, walk: Walk): Promise<Json | undefined> => {
    if (isText(content)) {
        return maskText(content, shield.mask);
    }
    return isList(content) ? mapAll(content, walk) : content;
};

// What an image or PDF source holds, for the shield: inline base64, or a URL it can only name. A Files API id or a
// source shape this does not know is never shown to the shield and goes as it is.
const binaryOf = (source: Json | undefined, fallback: string): ShieldBinary | undefined => {
    if (!isRecord(source)) {
        return undefined;
    }
    const data = source["data"];
    const mediaType = source["media_type"];
    const url = source["url"];
    if (source["type"] === "base64" && isText(data)) {
        return { mediaType: isText(mediaType) ? mediaType : fallback, data };
    }
    return source["type"] === "url" && isText(url) ? { mediaType: "url", data: url } : undefined;
};

const walkImage = async (block: JsonObject, shield: RequestShield): Promise<Json> => {
    const binary = binaryOf(block["source"], "application/octet-stream");
    const verdict = binary === undefined ? "keep" : await shield.image(binary);
    return verdict === "keep" ? block : textBlock(block, verdict.text);
};

// A PDF (inline or by URL) the shield replaced: the same document, now plain text, so its title, context, citations
// setting and cache breakpoint still apply.
const documentAsText = (block: JsonObject, text: string): JsonObject => ({
    ...block,
    source: { type: "text", media_type: "text/plain", data: text },
});

const walkDocumentSource = async (block: JsonObject, shield: RequestShield, walk: Walk): Promise<JsonObject> => {
    const source = block["source"];
    const binary = binaryOf(source, "application/pdf");
    if (binary !== undefined) {
        const verdict = await shield.document(binary);
        return verdict === "keep" ? block : documentAsText(block, verdict.text);
    }
    if (!isRecord(source)) {
        return block;
    }
    if (source["type"] === "text") {
        return patch(block, "source", await maskField(source, "data", shield.mask));
    }
    return source["type"] === "content"
        ? patch(block, "source", patch(source, "content", await walkContent(source["content"], shield, walk)))
        : block;
};

const walkDocument = async (block: JsonObject, shield: RequestShield, walk: Walk): Promise<JsonObject> => {
    const titled = await maskField(block, "title", shield.mask);
    return walkDocumentSource(await maskField(titled, "context", shield.mask), shield, walk);
};

const walkBlock = async (block: Json, shield: RequestShield): Promise<Json> => {
    if (!isRecord(block)) {
        return block;
    }
    const type = typeOf(block);
    const walk: Walk = async (inner) => walkBlock(inner, shield);
    if (!isText(type) || UNTOUCHED.has(type)) {
        return block;
    }
    switch (type) {
        case "text":
            return maskField(block, "text", shield.mask);
        case "image":
            return walkImage(block, shield);
        case "document":
            return walkDocument(block, shield, walk);
        case "tool_use":
        case "server_tool_use":
        case "mcp_tool_use": {
            const input = block["input"];
            return input === undefined ? block : patch(block, "input", await maskStrings(input, shield.mask));
        }
        case "tool_result":
        case "mcp_tool_result":
            return patch(block, "content", await walkContent(block["content"], shield, walk));
        case "search_result": {
            const titled = await maskField(block, "title", shield.mask);
            return patch(titled, "content", await walkContent(titled["content"], shield, walk));
        }
        default:
            return block;
    }
};

const walkMessage = async (message: Json, shield: RequestShield): Promise<Json> => {
    if (!isRecord(message)) {
        return message;
    }
    return patch(message, "content", await walkContent(message["content"], shield, async (block) => walkBlock(block, shield)));
};

// The note goes last: after every cache breakpoint, so the cached prefix before it is the same with or without it.
const walkSystem = async (system: Json | undefined, shield: RequestShield): Promise<Json | undefined> => {
    const { note } = shield;
    if (isText(system)) {
        const masked = await maskText(system, shield.mask);
        return note === undefined ? masked : withNote(masked, note);
    }
    if (isList(system)) {
        const blocks = await mapAll(system, async (block) => walkBlock(block, shield));
        return note === undefined ? blocks : [...blocks, { type: "text", text: note }];
    }
    return system === undefined || system === null ? note : system;
};

export const shieldAnthropicRequest = async (body: Json, shield: RequestShield): Promise<Json> => {
    if (!isRecord(body)) {
        return body;
    }
    const messages = body["messages"];
    const system = await walkSystem(body["system"], shield);
    const walked = isList(messages) ? await mapAll(messages, async (message) => walkMessage(message, shield)) : messages;
    // Always a fresh top-level object, so the gateway can set its own fields on what it sends without touching the original.
    return { ...patch(patch(body, "system", system), "messages", walked) };
};
