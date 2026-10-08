import { z } from "zod";

// A PROGRAM THIS SANDBOX BUILT, CARRIED TO A CONNECTED COMPUTER TO RUN THERE (`devices push`, then the device's app_start).
// The agent's CLI hands the daemon the bytes as the agent's own shell sees them; the daemon carries them over the device
// link in chunks through `stageArtifact`, and the machine files them under its own runs folder, one folder per content
// hash, so a second push of the same build is answered from what is already there and a running copy is never
// overwritten. Behind the device's "Run programs this sandbox sends" switch (`programs`), checked on the machine.

// One chunk's decoded size: small enough that a tunnel never sees a frame it would refuse, large enough that a 100 MB
// build is fifty calls.
export const ARTIFACT_CHUNK_BYTES = 2 * 1024 * 1024;
// The most one push carries, decoded. A build bigger than this is a disk image, not a program to try.
export const ARTIFACT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "a lowercase hex sha256");
// Names the folder a push lands in, so it is one plain path segment on every OS: no separators, no dots alone, nothing
// Windows reserves.
export const ArtifactNameSchema = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "letters, digits, dot, dash and underscore, starting with a letter or digit, at most 64");
// The file's own name as it was in the sandbox, kept so a Windows program still ends in `.exe`.
export const ArtifactFileNameSchema = z
    .string()
    .regex(/^[A-Za-z0-9 ._()+-]{1,200}$/, "a plain file name")
    .refine((name) => name !== "." && name !== ".." && !name.endsWith(".") && !name.endsWith(" "), "a plain file name");
// `file` is one file, filed as it is; `tar` a folder the CLI packed, unpacked on the machine.
export const ArtifactKindSchema = z.enum(["file", "tar"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
const UploadIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

export const StageArtifactSchema = z.discriminatedUnion("op", [
    // Whether this exact build is already staged here: the answer carries its path when it is, and nothing is sent.
    z.object({ op: z.literal("have"), name: ArtifactNameSchema, sha256: Sha256Schema, kind: ArtifactKindSchema, fileName: ArtifactFileNameSchema }).strict(),
    // One piece, at its offset; pieces arrive in order and a gap is refused.
    z
        .object({
            op: z.literal("chunk"),
            upload: UploadIdSchema,
            offset: z.int().nonnegative(),
            data: z.string().max(Math.ceil(ARTIFACT_CHUNK_BYTES / 3) * 4),
        })
        .strict(),
    // The last word: the machine checks size and hash, then files it. A mismatch throws the upload away.
    z
        .object({
            op: z.literal("commit"),
            upload: UploadIdSchema,
            name: ArtifactNameSchema,
            kind: ArtifactKindSchema,
            fileName: ArtifactFileNameSchema,
            size: z.int().nonnegative().max(ARTIFACT_MAX_BYTES),
            sha256: Sha256Schema,
        })
        .strict(),
    // A push the daemon gave up on; what arrived is deleted.
    z.object({ op: z.literal("abort"), upload: UploadIdSchema }).strict(),
]);
export type StageArtifact = z.infer<typeof StageArtifactSchema>;

export const StageArtifactResultSchema = z.object({
    // Where the build is on the machine: the file itself, or the folder a `tar` was unpacked into. Absent for a `have`
    // that found nothing, a chunk and an abort.
    path: z.string().optional(),
    // How many bytes of this upload the machine holds, answered to every chunk.
    received: z.int().nonnegative().optional(),
});
export type StageArtifactResult = z.infer<typeof StageArtifactResultSchema>;

// What `POST /devices/{name}/artifacts` answers the CLI.
export const PushedArtifactSchema = z.object({
    device: z.string(),
    path: z.string(),
    size: z.int().nonnegative(),
    sha256: Sha256Schema,
    // True when the machine already had this exact build and nothing was sent.
    reused: z.boolean(),
});
export type PushedArtifact = z.infer<typeof PushedArtifactSchema>;
