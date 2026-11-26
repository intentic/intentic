import { type JsonValue, parseJsonOr } from "@intentic/base/json";
import type { ToolResult } from "@intentic/extension-api";

// What @playwright/mcp answered a call, as the kit reads it (2026-11-26, moved from the daemon's evaluate-answer.ts): an
// answer is text in `### Title` sections, and browser_evaluate puts what the page returned, as JSON, under `### Result`.

// One `### Title` section of an answer.
interface Section {
    readonly title: string;
    readonly body: string;
}

const sectionsOf = (text: string): Section[] =>
    text
        .split(/^### /mu)
        .filter((chunk) => chunk.trim() !== "")
        .map((chunk) => {
            const [title = "", ...body] = chunk.split("\n");
            return { title, body: body.join("\n").trimEnd() };
        });

/** The answer's words, every text block of it. */
export const textOf = (result: ToolResult): string => result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

/** What the page returned, or the first line of why it returned nothing: the page was replaced mid-call, or it threw. */
export const evaluated = (result: ToolResult): { readonly value: JsonValue } | { readonly failure: string } => {
    const sections = sectionsOf(textOf(result));
    const answer = sections.find((section) => section.title === "Result");
    const missing = Symbol("missing");
    const value = answer === undefined ? missing : parseJsonOr<typeof missing>(answer.body, missing);
    if (value !== missing) {
        return { value };
    }
    const error = sections.find((section) => section.title === "Error")?.body ?? (textOf(result) || "the browser gave no answer");
    return { failure: error.split("\n")[0]?.slice(0, 200) ?? error };
};

/** Whether an answer says the page now waits on a file chooser (a click that opened one). */
export const choosingFile = (result: ToolResult): boolean => sectionsOf(textOf(result)).some((section) => section.title === "Modal state" && /file chooser/iu.test(section.body));

/** The first line an answer says: its error's, else its own; for a refusal to quote. */
export const firstLineOf = (result: ToolResult): string => {
    const error = sectionsOf(textOf(result)).find((section) => section.title === "Error")?.body;
    const line = (error ?? textOf(result)).split("\n").find((text) => text.trim() !== "" && !text.startsWith("###"));
    return line?.slice(0, 200) ?? "the browser said nothing";
};
