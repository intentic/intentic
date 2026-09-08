// public: the workspace outbox
import { z } from "zod";
// Files under `public/` are served as static, unauthenticated files at public-<slot>-<sandboxId>.<zone> — the
// process-free half of preview. The directory's existence is the switch: absent until something is published, removed
// again when the last file leaves.

export const PublicFileSchema = z.object({
    // Forward-slash, e.g. "report.pdf", "site/index.html".
    path: z.string().describe("Where it sits inside the outbox."),
    size: z.number().describe("Size in bytes."),
    modifiedAt: z.number().describe("When it last changed, in milliseconds."),
    url: z.string().optional().describe("Its public address. Absent when this sandbox has no outside address, or when the file is being refused."),
    blocked: z
        .string()
        .optional()
        .describe(
            "Why a file sitting in the outbox is not being served: a hidden name, a credential-shaped name, contents that look like a token, or sheer size. Only the publisher sees this; a stranger asking for the same file gets the same nothing every other miss gets.",
        ),
});
export type PublicFile = z.infer<typeof PublicFileSchema>;
export const PublicListSchema = z.object({
    url: z.string().optional().describe("Your public address, which every file's own hangs off. Absent on a sandbox with nowhere to publish to."),
    files: z.array(PublicFileSchema).describe("What the outbox holds."),
});
export type PublicList = z.infer<typeof PublicListSchema>;
export const PublishSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "What to publish, as a workspace path. It is copied rather than moved, so a repository does not lose its build output because somebody shared it.",
        ),
});
export const UnpublishSchema = z.object({
    path: z.string().min(1).describe("What to withdraw, as a path inside the outbox rather than a workspace path."),
});
export const PublishResultSchema = z.object({
    path: z.string().describe("Where it landed inside the outbox."),
    url: z.string().optional().describe("Its public address. Absent on a sandbox with nowhere to publish to."),
});
export type PublishResult = z.infer<typeof PublishResultSchema>;
