// Mime type for a raster attachment, shared by the three adapters that attach images to a prompt (acp, grok, pi) so the
// extension set lives in one place. Deliberately separate from the daemon's other mime tables
// (workspace-files-download.ts, public-files.ts), which answer different questions. Lives at the root of src/, not
// under runtimes/, which holds no code of its own.
export const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};
