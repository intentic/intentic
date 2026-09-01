import { readFile, writeFile } from "node:fs/promises";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../claude/claude-sdk.js";
import { z } from "zod";
import { resolveWithin } from "../workspace/workspace-files.js";
import { applyEdit, type HashlineOp, renderForRead } from "./hashline.js";

// The hashline file tools (in-process SDK MCP server, the uiServer/discord-voice pattern). Registered, and the native
// Edit/Write disabled, only when the hashlineEdits toggle is on. `read` tags each line + the whole file so `edit`
// can point at tags instead of retyping unchanged lines and reject a stale edit; `write` creates/overwrites whole
// files. Native Read stays enabled for viewing (images/PDFs); these own the mutation path plus the read-for-edit.

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

// Mirrors HashlineOp; kept next to the tool (the engine stays zod-free so it's trivially unit-testable).
const opSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("replace"), from: z.string(), to: z.string().optional(), lines: z.array(z.string()) }),
    z.object({ op: z.literal("insert"), after: z.string(), lines: z.array(z.string()) }),
    z.object({ op: z.literal("delete"), from: z.string(), to: z.string().optional() }),
]);

export const createHashlineServer = (root: string): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "hashline",
        tools: [
            sdk().tool(
                "read",
                "Read a text file for editing. Returns an `anchor` for the whole file and a short tag before each line: pass both back to hashline_edit to anchor an edit. Call this before hashline_edit. (For images/PDFs or plain viewing, the normal Read tool still works.)",
                { path: z.string().describe("Absolute or workspace-relative path to the file") },
                async ({ path }) => {
                    const abs = resolveWithin(root, path);
                    if (abs === undefined) {
                        return fail(`path is outside the workspace: ${path}`);
                    }
                    try {
                        return ok(renderForRead(await readFile(abs, "utf8")));
                    } catch (error) {
                        return fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                },
            ),
            sdk().tool(
                "edit",
                'Edit a file by anchored ops instead of retyping unchanged lines. Pass the `anchor` from a recent hashline_read of this file plus one or more ops, each anchored to line tags from that read: replace {from,to?,lines}, insert {after,lines} (after "^" = top of file), delete {from,to?}. The edit is rejected if the file changed since you read it, re-read for a fresh anchor. On success it returns the re-tagged file so you can chain further edits.',
                {
                    path: z.string().describe("Absolute or workspace-relative path to the file"),
                    anchor: z.string().describe("The file anchor from hashline_read"),
                    ops: z.array(opSchema).min(1).describe("Anchored edit ops, applied together"),
                },
                async ({ path, anchor, ops }) => {
                    const abs = resolveWithin(root, path);
                    if (abs === undefined) {
                        return fail(`path is outside the workspace: ${path}`);
                    }
                    let content: string;
                    try {
                        content = await readFile(abs, "utf8");
                    } catch (error) {
                        return fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                    let next: string;
                    try {
                        next = applyEdit(content, anchor, ops as HashlineOp[]);
                    } catch (error) {
                        return fail(error instanceof Error ? error.message : String(error));
                    }
                    await writeFile(abs, next);
                    return ok(renderForRead(next));
                },
            ),
            sdk().tool(
                "write",
                "Create a new file or overwrite an existing one with the given content. Use this for new files; use hashline_edit to change part of an existing file (far fewer output tokens).",
                { path: z.string().describe("Absolute or workspace-relative path"), content: z.string().describe("Full file content") },
                async ({ path, content }) => {
                    const abs = resolveWithin(root, path);
                    if (abs === undefined) {
                        return fail(`path is outside the workspace: ${path}`);
                    }
                    await writeFile(abs, content);
                    return ok(`wrote ${path} (${content.length} bytes)`);
                },
            ),
        ],
    });
