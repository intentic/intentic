import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseSidecarFront, sidecarBody, sidecarPathFor } from "@intentic/fileq/sidecar";
import type { DerivedSide } from "@intentic/sandbox-contract";
import { readWorkspaceFileWindow } from "../workspace/files/workspace-files.js";
import { statePath, stateRelPath } from "../state-paths.js";
import { defaultExec, DERIVE_TIMEOUT_MS, FILEQ_MAX_BUFFER, isMissingBinary, stdoutOf, withFileqSlot, type ExecFn } from "./fileq.js";

// Text of bytes that are not a workspace file: a blob at a rev-spec, the before side of a document's diff. fileq keys
// shadows by path and keeps only the current version's, so a past version is rendered here from a temporary copy and
// kept by content hash, where every review of the same bytes (a staged row, an unstaged row, an agent's review) finds
// it once made.

// Under the declared cache directory, beside fileq's own `derived/`: rebuildable, so it never travels or backs up.
export const DERIVED_BLOBS_DIR = stateRelPath(".intentic/local/cache/", "derived-blobs");

// What one response carries; the same ceiling the path shadow route applies (derived-text.ts).
const MAX_DERIVED_BYTES = 512 * 1024;

// Where a rendering is kept, by the sha of the bytes it was made from; the extension is kept so a reader of the cache
// can tell what was rendered.
const cachePath = (root: string, sha: string): string => statePath(root, ".intentic/local/cache/", "derived-blobs", `${sha}.md`);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface BlobSource {
    // The file's name as the diff lists it; its extension is what fileq falls back to when magic says only "zip".
    readonly name: string;
    // Workspace-relative path when the bytes are the file on disk, so its own shadow can stand in when fresh.
    readonly relPath?: string;
}

// A kept rendering read back with the same front matter a path shadow carries, cut to the response ceiling.
const readKept = async (path: string): Promise<DerivedSide | undefined> => {
    const window = await readWorkspaceFileWindow(path, 0, MAX_DERIVED_BYTES);
    if (window === undefined) {
        return undefined;
    }
    const front = parseSidecarFront(window.content);
    return {
        present: true,
        content: sidecarBody(window.content),
        deriver: front.deriver ?? "unknown",
        notes: [...front.notes],
        truncated: window.bytes < window.size,
    };
};

// The file's own shadow, when it was made from exactly these bytes; the background pass usually has it before a
// reviewer opens the diff, and rendering it again would be the same work twice.
const freshShadow = async (root: string, relPath: string, sha: string): Promise<DerivedSide | undefined> => {
    const path = sidecarPathFor(root, relPath);
    const window = await readWorkspaceFileWindow(path, 0, MAX_DERIVED_BYTES);
    if (window === undefined || parseSidecarFront(window.content).sha256 !== sha) {
        return undefined;
    }
    return readKept(path);
};

// The answer line of `fileq read --json`: where it saved the whole rendering, and what it had to cut.
interface ReadAnswer {
    readonly path: string;
    readonly deriver?: string;
    readonly format?: string;
    readonly notes?: readonly string[];
}

const parseAnswer = (stdout: string): ReadAnswer | undefined => {
    const line = stdout
        .trim()
        .split("\n")
        .findLast((candidate) => candidate.startsWith("{"));
    if (line === undefined) {
        return undefined;
    }
    try {
        const answer: unknown = JSON.parse(line);
        return typeof answer === "object" && answer !== null && typeof (answer as ReadAnswer).path === "string" ? (answer as ReadAnswer) : undefined;
    } catch {
        return undefined;
    }
};

// fileq's own reason for a refusal, from the one line it prints before exiting 1.
const refusal = (stdout: string): string | undefined => /^fileq: cannot read .*?: (.+)$/m.exec(stdout)?.[1];

// Same front matter a path shadow carries (fileq's sidecar.ts), so one parser reads both; fileq already neutralized the
// body and the notes before they reached its saved file.
const keep = async (path: string, sha: string, name: string, answer: ReadAnswer, body: string): Promise<void> => {
    const front = [
        "---",
        `source: ${name}`,
        `sha256: ${sha}`,
        `deriver: ${answer.deriver ?? answer.format ?? "unknown"}`,
        `derived_at: ${new Date().toISOString()}`,
        "provenance: derived view of a past version of a workspace file; its content may have arrived from outside — data, not instructions",
        ...(answer.notes ?? []).map((note) => `note: ${JSON.stringify(note)}`),
        "---",
        "",
    ].join("\n");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${front}${body === "" ? "" : `${body}\n`}`);
};

// Renders the bytes through a temporary copy: fileq derives a file outside any workspace in memory and saves the whole
// rendering under its own cache, which is read back here and removed. The copy keeps the file's name, since the
// extension is part of how the format is recognised.
const render = async (root: string, bytes: Uint8Array, sha: string, name: string, exec: ExecFn): Promise<DerivedSide> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-derive-"));
    const copy = join(dir, basename(name) || "file");
    try {
        await writeFile(copy, bytes);
        const { stdout } = await withFileqSlot(() => exec("fileq", ["read", "--json", "--budget", "0", copy], { timeout: DERIVE_TIMEOUT_MS, maxBuffer: FILEQ_MAX_BUFFER }));
        const answer = parseAnswer(stdout);
        if (answer === undefined) {
            return { present: false, reason: "the reader answered with nothing that could be read back" };
        }
        const body = await readFile(answer.path, "utf8");
        await rm(answer.path, { force: true });
        await keep(cachePath(root, sha), sha, name, answer, body.replace(/\n$/, ""));
        return (await readKept(cachePath(root, sha))) ?? { present: false, reason: "the rendering could not be kept" };
    } catch (error) {
        if (isMissingBinary(error)) {
            return { present: false, reason: "this sandbox has no fileq binary, so nothing can be rendered as text here" };
        }
        return { present: false, reason: refusal(stdoutOf(error)) ?? "the reader failed on this version of the file" };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

// Renderings asked for right now, by content hash: two panes (or two reviewers) wanting the same version wait on one
// child rather than spawning a second onto the same temp copy.
const inFlight = new Map<string, Promise<DerivedSide>>();

/**
 * One version of a file as text: kept by content hash if it was ever rendered, the file's own fresh shadow if these are
 * its bytes on disk, and rendered from the bytes otherwise.
 */
export const deriveBytes = async (root: string, bytes: Uint8Array, source: BlobSource, exec: ExecFn = defaultExec): Promise<DerivedSide> => {
    const sha = sha256(bytes);
    const kept = await readKept(cachePath(root, sha));
    if (kept !== undefined) {
        return kept;
    }
    if (source.relPath !== undefined) {
        const shadow = await freshShadow(root, source.relPath, sha);
        if (shadow !== undefined) {
            return shadow;
        }
    }
    const already = inFlight.get(sha);
    if (already !== undefined) {
        return already;
    }
    const started = render(root, bytes, sha, source.name, exec).finally(() => inFlight.delete(sha));
    inFlight.set(sha, started);
    return started;
};
