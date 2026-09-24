import { stat } from "node:fs/promises";
import { join } from "node:path";
import { estimateTokens } from "@intentic/base/format";
import { detectFormat } from "@intentic/fileq/formats";
import { parseSidecarFront, sha256OfFile, sidecarBody, sidecarPathFor } from "@intentic/fileq/sidecar";
import type { WorkspaceDerived } from "@intentic/sandbox-contract";
import { readWorkspaceFileWindow } from "../workspace/files/workspace-files.js";
import { defaultExec, DERIVE_TIMEOUT_MS, FILEQ_MAX_BUFFER, isMissingBinary, runFailure, stdoutOf, withFileqSlot, type ExecFn } from "./fileq.js";
import { sidecarStateOf, sidecarStatus } from "./sidecar-service.js";

// Reading a file's shadow for a person rather than an agent: the same markdown `fileq read` serves, plus the front
// matter's provenance, so a reader can see what was derived, by which reader, and what it had to cut.
// The shared tree only: a conversation's checkout is never shadowed (fileq refuses worktree paths), so there is no
// scope here to get wrong.

// What one response carries. Well past any real document's shadow and far under the daemon's own read ceiling, so a
// pathological one is cut rather than sent.
const MAX_DERIVED_BYTES = 512 * 1024;

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
    // Where the background pass stands is read alongside the shadow, never inferred from its absence: a file nothing
    // has rendered yet and a file waiting its turn are the same bytes on disk and different answers to a reader.
    const queue = sidecarStatus();
    if (window === undefined) {
        const derivable = await isDerivable(source);
        return {
            present: false,
            path: relPath,
            derivable,
            state: sidecarStateOf(relPath, derivable),
            queue,
            ...(reason === undefined ? {} : { reason }),
        };
    }
    const front = parseSidecarFront(window.content);
    const body = sidecarBody(window.content);
    // The same content test freshness uses everywhere in fileq: a hash, never an mtime, so a git checkout that rewrote
    // the file with an older timestamp still reads as changed. A source that has since vanished leaves its shadow the
    // last honest thing said about it, rather than marking it stale against nothing.
    const sha = await sha256OfFile(source).catch(() => undefined);
    const stale = sha !== undefined && sha !== front.sha256;
    return {
        present: true,
        path: relPath,
        content: body,
        // A shadow that exists can still be waiting: the file moved on under it and its re-derivation is in the queue.
        // A fresh one is settled whatever the queue is doing, so it says `idle` rather than reporting someone else's wait.
        state: stale ? sidecarStateOf(relPath, true) : "idle",
        queue,
        // A shadow whose front matter was hand-edited has no stamp left to name; it is still the text that was derived.
        deriver: front.deriver ?? "unknown",
        ...(front.derivedAt === undefined ? {} : { derivedAt: front.derivedAt }),
        ...(front.title === undefined ? {} : { title: front.title }),
        notes: [...front.notes],
        tokens: estimateTokens(body),
        truncated: window.bytes < window.size,
        stale,
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

// Derivations asked for right now, by path: two callers wanting the same file wait on the same child rather than
// spawning a second. The box-wide cap on children is fileq.ts's slot.
const inFlight = new Map<string, Promise<WorkspaceDerived>>();

const deriveOnce = async (root: string, relPath: string, exec: ExecFn): Promise<WorkspaceDerived> => {
    try {
        await withFileqSlot(() => exec("fileq", ["derive", "--json", relPath], { timeout: DERIVE_TIMEOUT_MS, maxBuffer: FILEQ_MAX_BUFFER }));
    } catch (error) {
        if (isMissingBinary(error)) {
            // `broken`, not `undeliverable`: the format may well be readable, this sandbox just has nothing to read it.
            return {
                present: false,
                path: relPath,
                derivable: false,
                state: "broken",
                queue: sidecarStatus(),
                reason: "this sandbox has no fileq binary, so nothing can be rendered as text here",
            };
        }
        // Exit 1 is fileq's "nothing derivable here", and the line it printed says which of its reasons applied.
        return await readDerivedText(root, relPath, runFailure(error) ?? skipReason(stdoutOf(error)));
    }
    return await readDerivedText(root, relPath);
};

/**
 * Derives one file now and answers with the result: the lazy path the CLI already runs. Concurrent asks for the same
 * file share one run, and the box never carries more than a couple at once.
 */
export const deriveText = (root: string, relPath: string, exec: ExecFn = defaultExec): Promise<WorkspaceDerived> => {
    const already = inFlight.get(relPath);
    if (already !== undefined) {
        return already;
    }
    const started = deriveOnce(root, relPath, exec).finally(() => inFlight.delete(relPath));
    inFlight.set(relPath, started);
    return started;
};
