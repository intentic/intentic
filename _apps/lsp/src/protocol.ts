import { createHash } from "node:crypto";
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

export interface DiagResponse {
    readonly ok: true;
    readonly diagnostics: readonly Diagnostic[];
}

export interface OkResponse {
    readonly ok: true;
}

export interface ErrorResponse {
    readonly ok: false;
    readonly error: string;
}

export type Response = DiagResponse | OkResponse | ErrorResponse;

// One daemon per workspace root, so two sandboxes (or a worktree and its parent) never share a program whose
// tsconfigs disagree. The root is hashed rather than embedded: socket paths are length-capped (~104 bytes on
// most platforms) and a deep worktree path blows straight through that.
export const socketPathFor = (root: string): string => join(tmpdir(), `intentic-lsp-${createHash("sha256").update(root).digest("hex").slice(0, 16)}.sock`);
