// public: the workspace outbox
import { z } from "zod";
// The mirror image of the reference shelf. Files under the workspace's `public/` directory are served as static
// files at public-<slot>-<sandboxId>.<zone>, with no auth in front of them, the process-free half of preview
// (a panel needs a running dev server; a file needs nothing). The directory's existence is the switch: it is
// absent until something is published and removed again when the last file leaves, so "publishing is off" is
// the resting state rather than a flag someone has to remember to set back.

export const PublicFileSchema = z.object({
    // Outbox-relative, forward-slash ("report.pdf", "site/index.html").
    path: z.string().describe("Where it sits inside the outbox."),
    size: z.number().describe("Size in bytes."),
    modifiedAt: z.number().describe("When it last changed, in milliseconds."),
    // The file's public URL. Absent when the sandbox has no tunnel, or when a guard refuses this file.
    url: z.string().optional().describe("Its public address. Absent when this sandbox has no outside address, or when the file is being refused."),
    // Why a file sitting in the outbox is NOT served, a hidden name, a credential-shaped name, contents that
    // match a known token format, or sheer size. The publisher reads it here; a stranger requesting the same
    // file only ever gets the same 404 every other miss returns, so this list can't be probed from outside.
    blocked: z
        .string()
        .optional()
        .describe(
            "Why a file sitting in the outbox is not being served: a hidden name, a credential-shaped name, contents that look like a token, or sheer size. Only the publisher sees this; a stranger asking for the same file gets the same nothing every other miss gets.",
        ),
});
export type PublicFile = z.infer<typeof PublicFileSchema>;
// `url` is the outbox root, the base every file's URL hangs off, and what the view shows as "your public
// address". Absent on a loopback/no-tunnel sandbox, which has nowhere to publish to.
export const PublicListSchema = z.object({
    url: z.string().optional().describe("Your public address, which every file's own hangs off. Absent on a sandbox with nowhere to publish to."),
    files: z.array(PublicFileSchema).describe("What the outbox holds."),
});
export type PublicList = z.infer<typeof PublicListSchema>;
// A WORKSPACE-relative path (the space the file tree speaks) to copy into the outbox. A copy, not a move: the
// repo a build output came from must not lose it because someone shared it.
export const PublishSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "What to publish, as a workspace path. It is copied rather than moved, so a repository does not lose its build output because somebody shared it.",
        ),
});
// An OUTBOX-relative path to withdraw, the path space PublicFile.path speaks, not the workspace's.
export const UnpublishSchema = z.object({
    path: z.string().min(1).describe("What to withdraw, as a path inside the outbox rather than a workspace path."),
});
export const PublishResultSchema = z.object({
    path: z.string().describe("Where it landed inside the outbox."),
    url: z.string().optional().describe("Its public address. Absent on a sandbox with nowhere to publish to."),
});
export type PublishResult = z.infer<typeof PublishResultSchema>;
