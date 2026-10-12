import { z } from "zod";

// What the editor sends ahead of a drop so a re-drop only moves what changed: POST /workspace/upload-diff takes each
// dropped file's destination path with its source size and mtime (ms, from File.lastModified), and answers the paths
// already identical on disk, whose bytes then never upload.
export const UploadManifestSchema = z.object({
    files: z.array(z.object({ path: z.string(), size: z.number(), mtime: z.number() })),
});
export type UploadManifest = z.infer<typeof UploadManifestSchema>;
export const UploadSkipSchema = z.object({ skip: z.array(z.string()) });
export type UploadSkip = z.infer<typeof UploadSkipSchema>;
