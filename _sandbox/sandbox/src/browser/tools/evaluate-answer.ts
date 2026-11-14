import { z } from "zod";
import { type JsonValue, parseJsonOr } from "@intentic/base/json";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";

// How the router's own tools (webmcp-call.ts, chatgpt-kit.ts) read what @playwright/mcp answered a call they sent it: an
// answer is text in `### Title` sections (response.ts serialize), and browser_evaluate and browser_run_code_unsafe put
// what the page or the code returned, as JSON, under `### Result`.

// One `### Title` section of an answer.
export interface Section {
    readonly title: string;
    readonly body: string;
}

export const ToolAnswerSchema = z.looseObject({
    content: z.array(z.looseObject({ text: z.string().exactOptional() })),
    isError: z.boolean().exactOptional(),
});

export const sectionsOf = (text: string): Section[] =>
    text
        .split(/^### /mu)
        .filter((chunk) => chunk.trim() !== "")
        .map((chunk) => {
            const [title = "", ...body] = chunk.split("\n");
            return { title, body: body.join("\n").trimEnd() };
        });

// The answer's sections, none for an answer that carries no text (a JSON-RPC error, a cancelled call).
const answerSections = (answer: RpcMessage): Section[] => {
    const read = ToolAnswerSchema.safeParse(answer.result);
    return read.success ? sectionsOf(read.data.content.map((block) => block.text ?? "").join("\n")) : [];
};

// What the page or the code returned, or the first line of why it returned nothing: the page was replaced mid-call,
// the code threw, no page is open.
export const evaluated = (answer: RpcMessage): { readonly value: JsonValue } | { readonly failure: string } => {
    const sections = answerSections(answer);
    const result = sections.find((section) => section.title === "Result");
    const missing = Symbol("missing");
    const value = result === undefined ? missing : parseJsonOr<typeof missing>(result.body, missing);
    if (value !== missing) {
        return { value };
    }
    const rpcError = RpcErrorSchema.safeParse(answer.error).data?.message;
    const error = sections.find((section) => section.title === "Error")?.body ?? rpcError ?? "the browser gave no answer";
    return { failure: error.split("\n")[0]?.slice(0, 200) ?? error };
};

const RpcErrorSchema = z.looseObject({ message: z.string() });
