import { stat } from "node:fs/promises";
import { join } from "node:path";
import { SingleFlight } from "@intentic/base/async";
import { estimateTokens } from "@intentic/base/format";
import { detectFormat } from "@intentic/fileq/formats";
import { parseSidecarFront, sha256OfFile, sidecarBody, sidecarPathFor } from "@intentic/fileq/sidecar";
import type { WorkspaceDerived } from "@intentic/sandbox-contract";
import { readWorkspaceFileWindow } from "../workspace/files/workspace-files.js";
import { defaultExec, DERIVE_TIMEOUT_MS, FILEQ_MAX_BUFFER, isMissingBinary, runFailure, stdoutOf, withFileqSlot, type ExecFn } from "./fileq.js";

// Reading a file's rendered text for a person rather than an agent: the same markdown `fileq read` serves from its cache,
// plus the front matter's provenance, so a reader can see what was derived, by which reader, and what it had to cut.
// Nothing renders in the background: a file has text once someone asks, and fileq keeps it until the file changes.
// The shared tree only: fileq refuses worktree paths, so there is no scope here to get wrong.

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

// Derivations asked for right now, by root and path: two callers wanting the same file wait on the same child rather
// than spawning a second, and a reader arriving mid-run is told it is being read rather than offered to start another.
// The root is part of the key: the same relative path under two roots is two files.
const inFlight = new SingleFlight<string, WorkspaceDerived>();
const flightKey = (root: string, relPath: string): string => `${root}\u0000${relPath}`;

// Who hears a rendering land: the /events stream, so a second reader of the same file refreshes. Renderings are written
// where the watcher does not look, so nothing else would tell it.
const landedListeners = new Set<(paths: string[]) => void>();

/** Subscribes to renderings landing; returns the unsubscribe. */
export const subscribeDerived = (listener: (paths: string[]) => void): (() => void) => {
    landedListeners.add(listener);
    return () => landedListeners.delete(listener);
};

// `reading` is passed rather than looked up by the derivation's own final read, which is still in flight when it asks.
const readText = async (root: string, relPath: string, reading: boolean, reason?: string): Promise<WorkspaceDerived> => {
    const source = join(root, relPath);
    const window = await readWorkspaceFileWindow(sidecarPathFor(root, relPath), 0, MAX_DERIVED_BYTES);
    if (window === undefined) {
        const derivable = await isDerivable(source);
        return {
            present: false,
            path: relPath,
            derivable,
            state: !derivable ? "undeliverable" : reading ? "deriving" : "idle",
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
        // A stale rendering can be mid-refresh; a fresh one is settled, whoever else is being read.
        state: stale && reading ? "deriving" : "idle",
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

/** A file's rendered text as it stands, with no derivation triggered; absent is the ordinary answer, not a failure. */
export const readDerivedText = (root: string, relPath: string): Promise<WorkspaceDerived> =>
    readText(root, relPath, inFlight.joined(flightKey(root, relPath)) !== undefined);

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
                reason: "this sandbox has no fileq binary, so nothing can be rendered as text here",
            };
        }
        // Exit 1 is fileq's "nothing derivable here", and the line it printed says which of its reasons applied.
        return await readText(root, relPath, false, runFailure(error) ?? skipReason(stdoutOf(error)));
    }
    return await readText(root, relPath, false);
};

/**
 * Derives one file now and answers with the result: the lazy path the CLI already runs. Concurrent asks for the same
 * file share one run, and the box never carries more than a couple at once.
 */
export const deriveText = (root: string, relPath: string, exec: ExecFn = defaultExec): Promise<WorkspaceDerived> => {
    const key = flightKey(root, relPath);
    const already = inFlight.joined(key);
    if (already !== undefined) {
        return already;
    }
    // Heard after the run's own `finally` has taken it out of flight, so the read a listener makes finds the settled text.
    return inFlight
        .run(key, () => deriveOnce(root, relPath, exec))
        .finally(() => {
            for (const listener of landedListeners) {
                listener([relPath]);
            }
        });
};
