import { z } from "zod";
import { ARTIFACT_CHUNK_BYTES } from "./device-artifacts.js";

// A FILE OR A FOLDER COPIED BETWEEN THIS SANDBOX AND A CONNECTED COMPUTER (`devices copy`), either way, to a path the
// agent names. 2026-11-17, the shinobi-society audit: to move a 12 MB tarball or a built binary, agents ran `docker exec …
// && docker cp …` on rog through run_command, which works only where the sandbox's own container is on that very machine,
// needs its container name, and passes every guard by. read_file and write_file carry text alone, through the model.
// The CLI reads and writes the bytes in the agent's own shell (its view of /work), the daemon relays them over the device
// link in chunks through `copyFile`, and the machine checks every chunk against the same rules as its file tools: the
// folders it may touch for both ways, and "Create and change files" (`write`) for a copy onto it.

// One chunk's decoded size: the artifact push's, which a tunnel already carries.
export const FILE_COPY_CHUNK_BYTES = ARTIFACT_CHUNK_BYTES;
// The most one copy carries, decoded: a thousand chunks, minutes on a good link. Anything bigger is a disk image or a
// backup, which a command on the computer moves better than a relay through the sandbox.
export const FILE_COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// How long packing or unpacking a folder may take on the computer; the daemon waits that plus the device's answer.
export const FILE_COPY_TAR_TIMEOUT_MS = 10 * 60_000;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "a lowercase hex sha256");
const CopyIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
// A path on the computer as the agent wrote it; the machine resolves it, links and all, against its folders.
const DevicePathSchema = z.string().min(1).max(4096);
// The source's own name, which a copy into a folder that exists lands under: one path segment, never `.` or `..`.
export const CopyNameSchema = z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !/[/\\\0]/.test(name) && name !== "." && name !== "..", "a plain file or folder name");
// `file` is one file; `tar` a folder, packed by whichever side holds it and unpacked by the other.
export const CopyKindSchema = z.enum(["file", "tar"]);
export type CopyKind = z.infer<typeof CopyKindSchema>;
const ChunkDataSchema = z.string().max(Math.ceil(FILE_COPY_CHUNK_BYTES / 3) * 4);

export const CopyFileSchema = z.discriminatedUnion("op", [
    // Onto the computer: where it will land (`path`, or `path/name` when `path` is a folder that exists), refused when
    // that is taken unless `overwrite`. `executable` carries the sandbox file's x bit to a POSIX computer. `probe` asks
    // every question and opens nothing, so a refusal is read before the first byte is sent.
    z
        .object({
            op: z.literal("put-open"),
            copy: CopyIdSchema,
            path: DevicePathSchema,
            name: CopyNameSchema,
            kind: CopyKindSchema,
            size: z.int().nonnegative().max(FILE_COPY_MAX_BYTES),
            overwrite: z.boolean(),
            executable: z.boolean(),
            probe: z.boolean().optional(),
        })
        .strict(),
    // One piece, at its offset; pieces arrive in order and a gap is refused.
    z.object({ op: z.literal("put-chunk"), copy: CopyIdSchema, offset: z.int().nonnegative(), data: ChunkDataSchema }).strict(),
    // The last word: the machine checks size and hash, then puts it in place. A mismatch throws the copy away.
    z.object({ op: z.literal("put-commit"), copy: CopyIdSchema, sha256: Sha256Schema }).strict(),
    // Off the computer: a file as it is, a folder packed as one tar first.
    z.object({ op: z.literal("get-open"), copy: CopyIdSchema, path: DevicePathSchema }).strict(),
    // The piece at `offset`, in order.
    z.object({ op: z.literal("get-chunk"), copy: CopyIdSchema, offset: z.int().nonnegative() }).strict(),
    // A copy finished or given up on: a put's part file is deleted, a get's handle and packed tar let go.
    z.object({ op: z.literal("close"), copy: CopyIdSchema }).strict(),
]);
export type CopyFile = z.infer<typeof CopyFileSchema>;

export const CopyFileResultSchema = z.object({
    // Where it is on the computer: where a put lands or landed, what a get reads.
    path: z.string().optional(),
    // A get-open's: what is coming, how big, under what name, and whether a POSIX computer has it executable.
    kind: CopyKindSchema.optional(),
    size: z.int().nonnegative().optional(),
    name: z.string().optional(),
    executable: z.boolean().optional(),
    // How many bytes of a put the machine holds, answered to every put-chunk.
    received: z.int().nonnegative().optional(),
    // A get-chunk's bytes, base64.
    data: ChunkDataSchema.optional(),
    // On a get's last chunk: the hash of everything it served, which the daemon checks what it relayed against.
    sha256: Sha256Schema.optional(),
});
export type CopyFileResult = z.infer<typeof CopyFileResultSchema>;

// What `POST /devices/{name}/files` answers the CLI; a GET answers the bytes, with these in `x-intentic-copy-*` headers.
export const CopiedFileSchema = z.object({
    device: z.string(),
    path: z.string(),
    kind: CopyKindSchema,
    size: z.int().nonnegative(),
    sha256: Sha256Schema,
});
export type CopiedFile = z.infer<typeof CopiedFileSchema>;
