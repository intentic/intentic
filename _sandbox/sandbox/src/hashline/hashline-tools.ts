import { readFile, realpath, stat } from "node:fs/promises";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { errorMessage } from "@intentic/base/errors";
import { queueOnFile, writeFileAtomic } from "@intentic/base/fs";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { sdk } from "../engines/claude-sdk.js";
import { z } from "zod";
import { resolveWithin } from "../workspace/files/workspace-files-paths.js";
import { applyEdit, type HashlineEdit, type HashlineOp, renderForEdit, renderForRead } from "./hashline.js";

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

// The file a write lands in: a symlink's target, since a rename over the link would replace it with a plain file.
const writeTarget = (abs: string): Promise<string> => realpath(abs).catch(() => abs);

// Atomic, and an existing file keeps its mode.
const replaceFile = async (target: string, content: string): Promise<void> => {
    const mode = await stat(target).then(
        (info) => info.mode & 0o7777,
        () => undefined,
    );
    await writeFileAtomic(target, content, mode);
};

export const createHashlineServer = (root: string): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "hashline",
        tools: [
            sdk().tool(
                "read",
                "Read a text file for editing. Returns an `anchor` for the whole file and a short tag before each line: pass both back to hashline_edit to anchor an edit. Shows up to 2000 lines per call (fewer when lines are long) and says where the rest starts; `offset` (1-based line) and `limit` read a range, and the anchor still covers the whole file. Call this before hashline_edit. (For images/PDFs or plain viewing, the normal Read tool still works.)",
                {
                    path: z.string().describe("Absolute or workspace-relative path to the file"),
                    offset: z.number().int().min(1).optional().describe("1-based line to start from (default 1)"),
                    limit: z.number().int().min(1).optional().describe("Most lines to show (default 2000)"),
                },
                async ({ path, offset, limit }) => {
                    const abs = resolveWithin(root, path);
                    if (abs === undefined) {
                        return fail(`path is outside the workspace: ${path}`);
                    }
                    try {
                        return ok(renderForRead(await readFile(abs, "utf8"), { offset, limit }));
                    } catch (error) {
                        return fail(`cannot read ${path}: ${errorMessage(error)}`);
                    }
                },
                { annotations: toolAnnotations("read") },
            ),
            sdk().tool(
                "edit",
                'Edit a file by anchored ops instead of retyping unchanged lines. Pass the `anchor` from your latest hashline_read or hashline_edit of this file plus one or more ops, each anchored to line tags: replace {from,to?,lines}, insert {after,lines} (after "^" = top of file), delete {from,to?}. The edit is rejected if the file changed since, re-read for a fresh anchor. On success it returns the new anchor and only the lines around each change, with their current tags; every other line keeps its tag, so chain further edits without re-reading.',
                {
                    path: z.string().describe("Absolute or workspace-relative path to the file"),
                    anchor: z.string().describe("The file anchor from hashline_read or the previous hashline_edit"),
                    ops: z.array(opSchema).min(1).describe("Anchored edit ops, applied together"),
                },
                async ({ path, anchor, ops }) => {
                    const abs = resolveWithin(root, path);
                    if (abs === undefined) {
                        return fail(`path is outside the workspace: ${path}`);
                    }
                    const target = await writeTarget(abs);
                    // Queued per file, so of two edits built on one anchor the second is refused as stale, not lost.
                    return queueOnFile(target, async () => {
                        let content: string;
                        try {
                            content = await readFile(target, "utf8");
                        } catch (error) {
                            return fail(`cannot read ${path}: ${errorMessage(error)}`);
                        }
                        let edit: HashlineEdit;
                        try {
                            edit = applyEdit(content, anchor, ops as HashlineOp[]);
                        } catch (error) {
                            return fail(errorMessage(error));
                        }
                        await replaceFile(target, edit.content);
                        return ok(renderForEdit(edit));
                    });
                },
                { annotations: toolAnnotations("write") },
            ),
            sdk().tool(
                "write",
                "Create a new file or overwrite an existing one with the given content; an existing file keeps its mode. Use this for new files; use hashline_edit to change part of an existing file (far fewer output tokens).",
                { path: z.string().describe("Absolute or workspace-relative path"), content: z.string().describe("Full file content") },
                async ({ path, content }) => {
                    const abs = resolveWithin(root, path);
                    if (abs === undefined) {
                        return fail(`path is outside the workspace: ${path}`);
                    }
                    const target = await writeTarget(abs);
                    await queueOnFile(target, () => replaceFile(target, content));
                    return ok(`wrote ${path} (${content.length} bytes)`);
                },
                { annotations: toolAnnotations("write") },
            ),
        ],
    });
