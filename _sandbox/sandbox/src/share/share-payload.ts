import { extname } from "node:path";
import type { TranscriptRow, TranscriptTool, ShareDetail, ToolCallContent } from "@intentic/sandbox-contract";
import { maskCredentialMaterial } from "@intentic/sandbox-contract";
import { SHARE_FILES_DIR } from "@intentic/sandbox-contract/share-paths";

// Pure, synchronous reduction of a conversation to what a stranger may read: testable without a renderer doing file
// I/O. Three steps, in order:
// detail (`messages` vs `everything`)
// redaction of every string either level keeps
// picture paths rewritten to published copies, so the page never addresses the workspace
// Dropped at both levels: `checkpointId` (meaningless off this machine), `notes` and interactive cards (no surface to
// draw them, unreadable JSON is worse than absent).

// The contract's credential masker, the vocabulary transcripts are masked with, and the one the public outbox sniffs the
// published page with (public-files.ts rule 5): what this leaves, the outbox serves. Its mask is visible (`***`) on
// purpose: a silently shortened line would read as the agent saying something odd.
export const redactSecrets = (text: string): string => maskCredentialMaterial(text);

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
// basename itself is kept for readability, sanitized to the share id's alphabet, unless names may not leave (the privacy
// shield is on): then the number alone, and the extension of what the shield publishes, a JPEG or a PNG (privacy-shield.ts).
class Pictures {
    private readonly byPath = new Map<string, string>();

    constructor(private readonly keepNames: boolean) {}

    published(path: string): string | undefined {
        if (!isPicture(path)) {
            return undefined;
        }
        const already = this.byPath.get(path);
        if (already !== undefined) {
            return already;
        }
        const base = (path.split("/").pop() ?? "picture").toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
        const number = this.byPath.size + 1;
        const published = this.keepNames
            ? `${SHARE_FILES_DIR}/${number}-${base}`
            : `${SHARE_FILES_DIR}/${number}${/\.jpe?g$/iu.test(path) ? ".jpg" : ".png"}`;
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
            return [{ type: "text", text: redactSecrets(entry.text) }];
        }
        if (entry.type === "diff") {
            return [
                {
                    ...entry,
                    ...(entry.oldText === undefined ? {} : { oldText: redactSecrets(entry.oldText) }),
                    newText: redactSecrets(entry.newText),
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
    ...(tool.target === undefined ? {} : { target: redactSecrets(tool.target) }),
    ...(tool.locations === undefined ? {} : { locations: tool.locations }),
    ...(tool.content === undefined ? {} : { content: shareContent(tool.content, pictures) }),
    ...(tool.children === undefined ? {} : { children: tool.children.map((child) => shareTool(child, pictures)) }),
    ...(tool.thinking === undefined ? {} : { thinking: redactSecrets(tool.thinking) }),
});

export interface SharedTranscript {
    readonly messages: TranscriptRow[];
    readonly pictures: readonly SharePicture[];
}

export interface ShareOptions {
    // Whether a published picture keeps its file's name; false while the privacy shield is on.
    readonly keepNames?: boolean;
}

export const shareTranscript = (messages: readonly TranscriptRow[], detail: ShareDetail, options: ShareOptions = {}): SharedTranscript => {
    const pictures = new Pictures(options.keepNames ?? true);
    const shared = messages.map((message): TranscriptRow => {
        const base: TranscriptRow = {
            role: message.role,
            text: redactSecrets(message.text),
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
            ...(message.thinking === undefined ? {} : { thinking: redactSecrets(message.thinking) }),
            ...(message.tools === undefined ? {} : { tools: message.tools.map((tool) => shareTool(tool, pictures)) }),
            ...(message.todos === undefined
                ? {}
                : {
                      todos: message.todos.map((todo) => ({
                          ...todo,
                          content: redactSecrets(todo.content),
                          ...(todo.activeForm !== undefined ? { activeForm: redactSecrets(todo.activeForm) } : {}),
                      })),
                  }),
        };
    });
    return { messages: shared, pictures: pictures.all() };
};
