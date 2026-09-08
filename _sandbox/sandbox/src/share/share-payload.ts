import { extname } from "node:path";
import type { TranscriptRow, TranscriptTool, ShareDetail, ToolCallContent } from "@intentic/sandbox-contract";
import { SHARE_FILES_DIR } from "@intentic/sandbox-contract/share-paths";
import { SECRET_PATTERNS } from "../public/public-files.js";

// Pure, synchronous reduction of a conversation to what a stranger may read: testable without a renderer doing file
// I/O. Three steps, in order:
// detail (`messages` vs `everything`)
// redaction of every string either level keeps
// picture paths rewritten to published copies, so the page never addresses the workspace
// Dropped at both levels: `checkpointId` (meaningless off this machine), `notes` and interactive cards (no surface to
// draw them, unreadable JSON is worse than absent).

// Visible marker, on purpose: a silently shortened line would read as the agent saying something odd.
export const REDACTED = "[redacted]";

const redact = (text: string): string => SECRET_PATTERNS.reduce((value, pattern) => value.replace(new RegExp(pattern, "g"), REDACTED), text);

// What the page can draw; a path outside this set is never copied, so an image entry can't be used to publish an
// arbitrary file.
const PICTURE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);

const isPicture = (path: string): boolean => PICTURE_EXTS.has(extname(path).toLowerCase());

// One picture to copy: where it is in the workspace, and what it is called beside the page.
export interface SharePicture {
    readonly source: string;
    // Relative to the share's own directory (`files/2-screenshot.png`).
    readonly published: string;
}

// Workspace path → published name, minted once per distinct path. Numbered because two paths can share a basename; the
// basename itself is kept for readability, sanitized to the share id's alphabet.
class Pictures {
    private readonly byPath = new Map<string, string>();

    published(path: string): string | undefined {
        if (!isPicture(path)) {
            return undefined;
        }
        const already = this.byPath.get(path);
        if (already !== undefined) {
            return already;
        }
        const base = (path.split("/").pop() ?? "picture").toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
        const published = `${SHARE_FILES_DIR}/${this.byPath.size + 1}-${base}`;
        this.byPath.set(path, published);
        return published;
    }

    all(): SharePicture[] {
        return [...this.byPath].map(([source, published]) => ({ source, published }));
    }
}

// A tool's output, redacted and with its pictures repointed; an image entry naming a path we can't publish is dropped
// rather than left addressing the workspace.
const shareContent = (content: readonly ToolCallContent[], pictures: Pictures): ToolCallContent[] =>
    content.flatMap((entry): ToolCallContent[] => {
        if (entry.type === "text") {
            return [{ type: "text", text: redact(entry.text) }];
        }
        if (entry.type === "diff") {
            return [
                {
                    ...entry,
                    ...(entry.oldText === undefined ? {} : { oldText: redact(entry.oldText) }),
                    newText: redact(entry.newText),
                },
            ];
        }
        const published = pictures.published(entry.path);
        return published === undefined ? [] : [{ type: "image", path: published }];
    });

// One tool call, recursively: a delegation's nested calls are part of the work it did.
const shareTool = (tool: TranscriptTool, pictures: Pictures): TranscriptTool => ({
    id: tool.id,
    name: tool.name,
    category: tool.category,
    status: tool.status,
    ...(tool.target === undefined ? {} : { target: redact(tool.target) }),
    ...(tool.locations === undefined ? {} : { locations: tool.locations }),
    ...(tool.content === undefined ? {} : { content: shareContent(tool.content, pictures) }),
    ...(tool.children === undefined ? {} : { children: tool.children.map((child) => shareTool(child, pictures)) }),
    ...(tool.thinking === undefined ? {} : { thinking: redact(tool.thinking) }),
});

export interface SharedTranscript {
    readonly messages: TranscriptRow[];
    readonly pictures: readonly SharePicture[];
}

export const shareTranscript = (messages: readonly TranscriptRow[], detail: ShareDetail): SharedTranscript => {
    const pictures = new Pictures();
    const shared = messages.map((message): TranscriptRow => {
        const base: TranscriptRow = {
            role: message.role,
            text: redact(message.text),
            ...(message.sentAt === undefined ? {} : { sentAt: message.sentAt }),
            // Placed rows keep their mark; a share is a human audience, the only one the flag exists for.
            ...(message.placed === true ? { placed: true } : {}),
        };
        // Attachments ride both levels, part of the prompt; unpublishable ones drop rather than becoming dead links.
        const attachments = (message.attachments ?? []).flatMap((path) => {
            const published = pictures.published(path);
            return published === undefined ? [] : [published];
        });
        const withAttachments = attachments.length === 0 ? base : { ...base, attachments };
        if (detail === "messages") {
            return withAttachments;
        }
        return {
            ...withAttachments,
            ...(message.thinking === undefined ? {} : { thinking: redact(message.thinking) }),
            ...(message.tools === undefined ? {} : { tools: message.tools.map((tool) => shareTool(tool, pictures)) }),
            ...(message.todos === undefined
                ? {}
                : {
                      todos: message.todos.map((todo) => ({
                          ...todo,
                          content: redact(todo.content),
                          ...(todo.activeForm !== undefined ? { activeForm: redact(todo.activeForm) } : {}),
                      })),
                  }),
        };
    });
    return { messages: shared, pictures: pictures.all() };
};
