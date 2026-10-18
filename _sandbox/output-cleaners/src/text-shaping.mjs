// MCP tool text has no shell command to classify, so it takes the generic stages alone, with budgets its caller names
// (a browser snapshot earns a larger one): the same dedup, wide-run cut and capped head and tail Bash output gets, and
// the same diagnostic lines kept from the cut middle (output-cap.mjs priorityCap). Read by guard/mcp-output.ts.
import { ANSI, bodyBytes, collapseCr } from "./cleaner-shapes.mjs";
import { capOutput } from "./output-cap.mjs";
import { dedupeRuns, elideWideRuns } from "./repeated-output.mjs";

export const cleanToolText = (text, { chars = 12_000, lines = 100, head = 30, tail = 50, enabled = new Set(["dedup", "wide", "cap"]) } = {}) => {
    const input = text.replaceAll(ANSI, "").split("\n").map(collapseCr);
    const deduped = enabled.has("dedup") ? dedupeRuns(input) : input;
    const compact = enabled.has("wide") && bodyBytes(deduped) > chars ? elideWideRuns(deduped) : deduped;
    return (enabled.has("cap") ? capOutput(compact, "", { chars, lines, head, tail }) : compact).join("\n");
};
