import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnostic } from "./diag.js";

/* The daemon's wire protocol: newline-delimited JSON over a unix socket, one request per line, one response per
 * line. Deliberately not LSP-over-stdio — there is no editor here, the callers are a CLI and a PostToolUse hook,
 * and both want one blocking question answered as fast as possible. */

export interface DiagRequest {
    readonly verb: "diag";
    // Files to report on. Anything listed is also adopted as "open" and kept current from then on.
    readonly files: readonly string[];
    // Files known to have just changed (the agent's own edit). Applied before the check.
    readonly touched?: readonly string[];
}

export interface PingRequest {
    readonly verb: "ping";
}

export interface ShutdownRequest {
    readonly verb: "shutdown";
}

export type Request = DiagRequest | PingRequest | ShutdownRequest;

// One file the daemon would not vouch for, and why: its project's config chain or type foundations failed to
// load from where the daemon runs, so any diagnostics would be artifacts of that failure, not facts about code.
export interface Unavailable {
    readonly file: string;
    readonly reason: string;
}

// What a diag can say, daemon-side and wire-side alike. A file appears in `unavailable` OR contributes to
// `diagnostics`; a file in neither list was checked and is clean. The caller must be able to tell "checked, and
// clean" from "could not check" — only the first is a verdict.
export interface DiagReport {
    readonly diagnostics: readonly Diagnostic[];
    readonly unavailable: readonly Unavailable[];
}

export interface DiagResponse extends DiagReport {
    readonly ok: true;
}

export interface OkResponse {
    readonly ok: true;
}

export interface ErrorResponse {
    readonly ok: false;
    readonly error: string;
}

export type Response = DiagResponse | OkResponse | ErrorResponse;

// One daemon per workspace root, named by WHAT the directory is rather than what it is called. The path is not
// an identity: an isolated turn bind-mounts its own tree over the same /work path, so two mount namespaces name
// two DIFFERENT trees identically, and a daemon keyed on the path answered one caller with the other's files —
// every diagnostic about the wrong content.
//
// dev:ino alone, and deliberately WITHOUT the path: the same directory has different names on either side of a
// mount boundary, and a hook outside a turn's namespace has to derive the socket of a daemon living inside it
// from the only name it can reach (client.ts). Including the path would give those two names two sockets and the
// caller would talk to a daemon that cannot see the files it is asking about — which is the whole failure this
// keying exists to prevent. It also makes true what this always claimed: two paths to one tree (a symlink, a
// bind mount) converge on one daemon.
//
// Hashed because socket paths are length-capped (~104 bytes on most platforms) and a deep worktree path blows
// straight through that.
export const socketPathFor = (root: string): string => {
    const stat = statSync(root);
    return join(tmpdir(), `intentic-lsp-${createHash("sha256").update(`${stat.dev}\0${stat.ino}`).digest("hex").slice(0, 16)}.sock`);
};
