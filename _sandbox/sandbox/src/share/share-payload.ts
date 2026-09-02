import { extname } from "node:path";
import type { RestoredMessage, RestoredToolCall, ShareDetail, ToolCallContent } from "@intentic/sandbox-contract";
import { SHARE_FILES_DIR } from "@intentic/sandbox-contract/share-paths";
import { SECRET_PATTERNS } from "../public/public-files.js";

/* WHAT ACTUALLY LEAVES, the one place a conversation is reduced to the thing a stranger may read.
 *
 * Pure and synchronous on purpose: everything about what a share contains is decided here, over plain values,
 * so the questions that matter ("does a messages-only share carry the diffs?", "does an API key pasted into a
 * prompt travel?") are answered by a unit test rather than by reading a renderer that is also doing file I/O.
 *
 * Three reductions, in order:
 *   1. DETAIL. `messages` keeps the two speakers' words; `everything` adds the agent's work and its thinking.
 *   2. REDACTION, on every string either level keeps.
 *   3. PICTURES. Workspace paths are rewritten to the copies that will sit beside the page, and the caller is
 *      told which files to copy. A page that still addressed a workspace path would be a page asking a
 *      recipient's browser for a file it has no business fetching (and could not fetch anyway).
 *
 * What is dropped in BOTH levels, and why it is not a third option:
 *   · `checkpointId`, an address in the daemon's own rewind state. Meaningless off this machine.
 *   · `notes`, the context the daemon prepended to a turn (a rebase that moved the branch, dependencies that
 *     are behind, retrieved workspace context). The published page has no surface that draws them, so keeping
 *     them would publish text nobody can read, which is strictly worse than not keeping it.
 *   · The cards a turn parked on (`question`, `plan`, `permission`, …, RestoredMessageSchema's card fields),
 *     for the same reason: the share view draws prose, thinking and tool cards and nothing interactive, so
 *     a card would leave as unreadable JSON. The day it draws them, the question and its picks belong at
 *     BOTH levels, they are the two speakers deciding something together. */

// The marker a matched secret leaves behind. Visible on purpose: a silently shortened line reads as the agent
// having said something odd, where this reads as what it is.
export const REDACTED = "[redacted]";

const redact = (text: string): string => SECRET_PATTERNS.reduce((value, pattern) => value.replace(new RegExp(pattern, "g"), REDACTED), text);

// What the page can actually draw. A path that is not one of these is not a picture, whatever a tool called it
//, and since this list is also what decides which workspace bytes get copied out, it is the reason a share
// cannot be talked into publishing an arbitrary file by naming it in an image entry.
const PICTURE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);

const isPicture = (path: string): boolean => PICTURE_EXTS.has(extname(path).toLowerCase());

// One picture to copy: where it is in the workspace, and what it is called beside the page.
export interface SharePicture {
    readonly source: string;
    // Relative to the share's own directory, which is what the payload now carries, `files/2-screenshot.png`.
    readonly published: string;
}

/* Workspace path → published name, minted once per distinct path so a screenshot shown three times is copied
 * once. Numbered because two conversations' worth of `screenshot.png` from different directories collide on
 * their basename alone, and a share that quietly showed the wrong picture would be worse than one that showed
 * none. The basename is kept for the readable half, sanitized to the same alphabet the share id uses. */
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

// A tool's output, redacted and with its pictures repointed. An image entry whose path is not a picture we can
// publish is dropped rather than left addressing the workspace.
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

// One tool call, recursively, a delegation's nested calls are part of the work it did.
const shareTool = (tool: RestoredToolCall, pictures: Pictures): RestoredToolCall => ({
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
    readonly messages: RestoredMessage[];
    readonly pictures: readonly SharePicture[];
}

export const shareTranscript = (messages: readonly RestoredMessage[], detail: ShareDetail): SharedTranscript => {
    const pictures = new Pictures();
    const shared = messages.map((message): RestoredMessage => {
        const base: RestoredMessage = {
            role: message.role,
            text: redact(message.text),
            ...(message.sentAt === undefined ? {} : { sentAt: message.sentAt }),
            // A row the user placed wearing the agent's voice keeps its mark. A share is a HUMAN-facing page,
            // the one audience the flag exists for, and a recipient reading planted words as the agent's own
            // is exactly the confusion the mark was added to prevent. (The agent-facing handoff stays blind to
            // it; see RestoredMessageSchema.)
            ...(message.placed === true ? { placed: true } : {}),
        };
        /* Attachments ride BOTH levels: a screenshot the user attached is part of what they said, not part of
         * what the agent did, so leaving it out of a messages-only share would cut the prompt in half. Ones we
         * cannot publish (a .pdf, a path that is no longer there) drop out rather than becoming dead links. */
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
