import { ORPCError } from "@orpc/server";
import { opt } from "../../opt.js";
import { openRecorded, pageMediaKeyPath, pageMediaRoots, verifiedPageMedia } from "../../workspace/files/stored/stored-page-media.js";
import {
    ARTIFACT_CHUNK_BYTES,
    ARTIFACT_MAX_BYTES,
    type ArtifactEntry,
    artifactFile,
    artifactsSince,
    checkoutFile,
    fileDigest,
    readRange,
    readWholeFile,
    sha256Of,
} from "../../workspace/files/stored/stored-artifacts.js";
import { readStoredPage } from "../../workspace/files/stored/stored-pages.js";

/* THE FILES A RUNNER SERVES ITS PARENT, by the paths its turns' frames name: a page a turn showed, a picture in the
   artifacts folder or in the conversation's own checkout, what a turn left in the artifacts folder, and the video and
   audio a page streams. Each is resolved inside the one folder it may come from, links included, so a path that climbs
   out names nothing; anything not served answers NOT_FOUND, which an older parent never asks for. */

export interface FileDoorDeps {
    readonly workspaceRoot: string;
    readonly historyRoot: string;
    // A conversation's checkout on this runner (its agent worktree).
    readonly checkoutOf: (conversationId: string) => string;
}

// A conversation id as it names a folder: nothing that could climb out of the worktrees root.
const CONVERSATION_ID = /^[A-Za-z0-9_-]+$/;

const notFound = (message: string): ORPCError<"NOT_FOUND", unknown> => new ORPCError("NOT_FOUND", { message });

export const readPageDoor = async (deps: FileDoorDeps, input: { readonly path: string }): Promise<{ html: string }> => {
    const html = await readStoredPage(deps.workspaceRoot, input.path);
    if (html === undefined) {
        throw notFound(`this runner holds no page at ${input.path}`);
    }
    return { html };
};

export interface ReadArtifactInput {
    readonly path: string;
    readonly have?: string | undefined;
    readonly conversationId?: string | undefined;
    readonly offset?: number | undefined;
    readonly length?: number | undefined;
}

// Where an asked-for file is: the artifacts folder, or the named conversation's checkout.
const fileOf = async (deps: FileDoorDeps, input: ReadArtifactInput): Promise<string | undefined> => {
    if (input.conversationId === undefined) {
        return artifactFile(deps.workspaceRoot, input.path);
    }
    return CONVERSATION_ID.test(input.conversationId) ? checkoutFile(deps.checkoutOf(input.conversationId), input.path) : undefined;
};

const tooLarge = (path: string, cap: number): ORPCError<"PAYLOAD_TOO_LARGE", unknown> =>
    new ORPCError("PAYLOAD_TOO_LARGE", { message: `${path} is over ${cap / 1024 / 1024} MiB, so it stays on the runner` });

// The whole file, as a parent that asks for no piece reads it.
const wholeOf = async (file: string, input: ReadArtifactInput): Promise<{ bytesBase64?: string; size?: number }> => {
    const read = await readWholeFile(file);
    if (read.kind === "none") {
        throw notFound(`this runner holds no artifact at ${input.path}`);
    }
    if (read.kind === "too-large") {
        throw tooLarge(input.path, ARTIFACT_MAX_BYTES);
    }
    return sha256Of(read.bytes) === input.have ? {} : { bytesBase64: read.bytes.toString("base64") };
};

export const readArtifactDoor = async (deps: FileDoorDeps, input: ReadArtifactInput): Promise<{ bytesBase64?: string; size?: number; sha256?: string }> => {
    const file = await fileOf(deps, input);
    if (file === undefined) {
        throw notFound(`this runner holds no artifact at ${input.path}`);
    }
    if (input.offset === undefined && input.length === undefined) {
        return wholeOf(file, input);
    }
    const read = await readRange(file, input.offset ?? 0, input.length ?? ARTIFACT_CHUNK_BYTES);
    if (read.kind === "none") {
        throw notFound(`this runner holds no artifact at ${input.path}`);
    }
    if (read.kind === "too-large") {
        throw tooLarge(input.path, read.size);
    }
    // Compared with the whole file, so a parent already holding it is answered without a byte. The first piece of a file
    // in more than one carries its digest, for the parent to check what it assembled (a file changing between pieces).
    const digest = input.have !== undefined || ((input.offset ?? 0) === 0 && read.bytes.length < read.size) ? await fileDigest(file) : undefined;
    if (input.have !== undefined && digest === input.have) {
        return { size: read.size };
    }
    return { bytesBase64: read.bytes.toString("base64"), size: read.size, ...opt("sha256", (input.offset ?? 0) === 0 ? digest : undefined) };
};

export const listArtifactsDoor = async (deps: FileDoorDeps, input: { readonly withinMs: number }): Promise<{ files: ArtifactEntry[] }> => ({
    files: await artifactsSince(deps.workspaceRoot, Date.now() - input.withinMs),
});

export interface ReadPageMediaInput {
    readonly page: string;
    readonly index: number;
    readonly offset: number;
    readonly length: number;
}

// Served only as this runner's own route would stream it: a manifest it signed for that very page, and the file still the
// one the page showed (page-media.routes.ts).
export const readPageMediaDoor = async (deps: FileDoorDeps, input: ReadPageMediaInput): Promise<{ bytesBase64: string; size: number; sha256?: string }> => {
    const html = await readStoredPage(deps.workspaceRoot, input.page);
    const files = html === undefined ? undefined : await verifiedPageMedia(pageMediaKeyPath(deps.historyRoot), input.page, html);
    const file = files?.[input.index];
    const opened = file === undefined ? undefined : await openRecorded(file, pageMediaRoots(deps.workspaceRoot, deps.historyRoot, input.page));
    if (file === undefined || opened === undefined || !("handle" in opened)) {
        throw notFound(`this runner serves no media ${input.index} for ${input.page}`);
    }
    try {
        const want = Math.max(0, Math.min(input.length, ARTIFACT_CHUNK_BYTES, file.size - input.offset));
        const bytes = Buffer.alloc(want);
        const { bytesRead } = want === 0 ? { bytesRead: 0 } : await opened.handle.read(bytes, 0, want, input.offset);
        const digest = input.offset === 0 && bytesRead < file.size ? await fileDigest(file.path) : undefined;
        return { bytesBase64: bytes.subarray(0, bytesRead).toString("base64"), size: file.size, ...opt("sha256", digest) };
    } finally {
        await opened.handle.close();
    }
};
