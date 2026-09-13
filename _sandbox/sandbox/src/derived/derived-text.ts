import { stat } from "node:fs/promises";
import { join } from "node:path";
import { estimateTokens } from "@intentic/base/format";
import { detectFormat } from "@intentic/fileq/formats";
import { parseSidecarFront, sha256OfFile, sidecarBody, sidecarPathFor } from "@intentic/fileq/sidecar";
import type { WorkspaceDerived } from "@intentic/sandbox-contract";
import { readWorkspaceFileWindow } from "../workspace/files/workspace-files.js";
import { defaultExec, FILEQ_MAX_BUFFER, isMissingBinary, stdoutOf, type ExecFn } from "./fileq.js";

// Reading a file's shadow for a person rather than an agent: the same markdown `fileq read` serves, plus the front
// matter's provenance, so a reader can see what was derived, by which reader, and what it had to cut.
// The shared tree only: a conversation's checkout is never shadowed (fileq refuses worktree paths), so there is no
// scope here to get wrong.

// What one response carries. Well past any real document's shadow and far under the daemon's own read ceiling, so a
// pathological one is cut rather than sent.
const MAX_DERIVED_BYTES = 512 * 1024;
// An interactive derive: long enough for a scanned pdf's OCR, short enough that a browser is not left holding a
// request nobody will wait for.
const DERIVE_TIMEOUT_MS = 120_000;

// Whether this file has a reader at all, which is what decides between offering to derive it and saying nothing can.
// Magic first, like everywhere else in fileq, so a renamed archive still answers yes; a file that is not there answers
// no, since the extension alone would otherwise vouch for a path with nothing behind it.
const isDerivable = async (absPath: string): Promise<boolean> => {
    const source = await stat(absPath).catch(() => undefined);
    return source?.isFile() === true && (await detectFormat(absPath).catch(() => undefined)) !== undefined;
};

/** A file's shadow as it stands, with no derivation triggered; absent is the ordinary answer, not a failure. */
export const readDerivedText = async (root: string, relPath: string, reason?: string): Promise<WorkspaceDerived> => {
    const source = join(root, relPath);
    const window = await readWorkspaceFileWindow(sidecarPathFor(root, relPath), 0, MAX_DERIVED_BYTES);
    if (window === undefined) {
        return { present: false, path: relPath, derivable: await isDerivable(source), ...(reason === undefined ? {} : { reason }) };
    }
    const front = parseSidecarFront(window.content);
    const body = sidecarBody(window.content);
    // The same content test freshness uses everywhere in fileq: a hash, never an mtime, so a git checkout that rewrote
    // the file with an older timestamp still reads as changed. A source that has since vanished leaves its shadow the
    // last honest thing said about it, rather than marking it stale against nothing.
    const sha = await sha256OfFile(source).catch(() => undefined);
    return {
        present: true,
        path: relPath,
        content: body,
        // A shadow whose front matter was hand-edited has no stamp left to name; it is still the text that was derived.
        deriver: front.deriver ?? "unknown",
        ...(front.derivedAt === undefined ? {} : { derivedAt: front.derivedAt }),
        ...(front.title === undefined ? {} : { title: front.title }),
        notes: [...front.notes],
        tokens: estimateTokens(body),
        truncated: window.bytes < window.size,
        stale: sha !== undefined && sha !== front.sha256,
    };
};

// `fileq derive --json` prints one outcome object per line; with one file asked for, the last line is its verdict.
const skipReason = (stdout: string): string | undefined => {
    const last = stdout
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith("{"));
    if (last === undefined) {
        return undefined;
    }
    try {
        const outcome: unknown = JSON.parse(last);
        const reason = (outcome as { reason?: unknown }).reason;
        return typeof reason === "string" ? reason : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Derives one file now and answers with the result: the lazy path the CLI already runs, reachable by someone looking
 * at the file rather than by the background sweep.
 */
export const deriveText = async (root: string, relPath: string, exec: ExecFn = defaultExec): Promise<WorkspaceDerived> => {
    try {
        await exec("fileq", ["derive", "--json", relPath], { timeout: DERIVE_TIMEOUT_MS, maxBuffer: FILEQ_MAX_BUFFER });
        return await readDerivedText(root, relPath);
    } catch (error) {
        if (isMissingBinary(error)) {
            return { present: false, path: relPath, derivable: false, reason: "this sandbox has no fileq binary, so nothing can be rendered as text here" };
        }
        // Exit 1 is fileq's "nothing derivable here", and the line it printed says which of its reasons applied.
        return await readDerivedText(root, relPath, skipReason(stdoutOf(error)));
    }
};
