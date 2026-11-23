import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "pino";
import { resolveRealWithin, resolveWithin } from "../../workspace/files/workspace-files-paths.js";

/* FILES A MESSAGE POINTS AT, CARRIED TO A RUNNER AS BYTES. The runner resolves no path of the parent's: a turn's chips
   and mentions, a steer's, and the files attached to an answer all name workspace paths on the parent, which the
   runner's mirror lacks (an upload, an ignored or uncommitted file). The parent reads each and sends it inline; the
   runner writes them at the same workspace paths before it applies the message. */

export interface InlineFile {
    readonly path: string;
    readonly bytesBase64: string;
}

// Past this a file a message names stays behind: what a message carries travels in one socket frame, as base64.
export const INLINE_FILE_MAX_BYTES = 16 * 1024 * 1024;
// And past this all of a message's files together, for the same frame.
const INLINE_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;

export interface NamedFiles {
    // Chosen by whoever sent the message: one resolving outside the workspace refuses the message.
    readonly attachments?: readonly string[] | undefined;
    // Read out of the words: one resolving outside the workspace is dropped, since nobody chose it.
    readonly mentions?: readonly string[] | undefined;
}

export type Inlined = { readonly files: InlineFile[] | undefined; readonly invalid?: undefined } | { readonly invalid: string; readonly files?: undefined };

// The bytes of the regular file at `real`, refused (undefined) past `max`; sized before it is read.
const readCapped = async (real: string, max: number): Promise<Buffer | undefined> => {
    const handle = await open(real, "r");
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > max) {
            return undefined;
        }
        return await handle.readFile();
    } finally {
        await handle.close();
    }
};

/** The files a message names (workspace-relative), as bytes, each once, by the rule composeSteerText applies where the
 *  words are composed here: inside the workspace on disk, links resolved, before a byte is read. An escaping attachment
 *  refuses the message; an escaping mention is dropped. One that cannot be read or is past the caps costs itself. */
export const inlineFiles = async (workspaceRoot: string, logger: Pick<Logger, "warn">, named: NamedFiles): Promise<Inlined> => {
    const wanted: { readonly path: string; readonly real: string }[] = [];
    const chosen = new Set(named.attachments ?? []);
    for (const path of new Set([...chosen, ...(named.mentions ?? [])])) {
        const inside = await resolveRealWithin(workspaceRoot, path);
        if (inside === undefined && chosen.has(path)) {
            return { invalid: `invalid attachment path: ${path}` };
        }
        if (inside !== undefined) {
            wanted.push({ path, real: inside.real });
        }
    }
    const files: InlineFile[] = [];
    let total = 0;
    for (const { path, real } of wanted) {
        try {
            const bytes = await readCapped(real, Math.min(INLINE_FILE_MAX_BYTES, INLINE_MESSAGE_MAX_BYTES - total));
            if (bytes === undefined) {
                logger.warn({ path }, "runner: a file the message names is not a file, or too large to carry, so it stays here");
                continue;
            }
            total += bytes.length;
            files.push({ path, bytesBase64: bytes.toString("base64") });
        } catch (error) {
            logger.warn({ err: error, path }, "runner: a file the message names could not be read");
        }
    }
    return { files: files.length > 0 ? files : undefined };
};

/** Writes files the parent sent at their workspace paths here. A path resolving outside the workspace is an attempt, not
 *  an attachment: nothing is written and it throws, so the whole message is refused. */
export const materializeFiles = async (workspaceRoot: string, files: readonly InlineFile[] | undefined): Promise<void> => {
    const targets = (files ?? []).map((file) => {
        const target = resolveWithin(workspaceRoot, file.path);
        if (target === undefined) {
            throw new Error(`attachment path escapes the workspace: ${file.path}`);
        }
        return { target, file };
    });
    for (const { target, file } of targets) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(file.bytesBase64, "base64"));
    }
};
