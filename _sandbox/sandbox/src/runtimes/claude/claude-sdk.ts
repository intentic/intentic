import { pathToFileURL } from "node:url";
import * as baked from "@anthropic-ai/claude-agent-sdk";
import { errorMessage } from "@intentic/base/errors";
import { CLAUDE_SDK_EXPORTS } from "../../engines/engine-descriptors.js";
import { resolveEngine } from "../../engines/engine-resolve.js";
import { quarantineVersion } from "../../engines/engine-store.js";

// The Claude Code SDK (JS + ~300MB CLI binary) loads together from one prefix, engine store or image, since a
// mismatched pair has never run upstream. Resolved into a synchronous binding at boot and at each turn's start, so a
// bad store copy quarantines and falls back to the image.

export type ClaudeSdk = typeof baked;

let current: ClaudeSdk = baked;
// Store version actually imported by this process, not derived live; decides whether a refresh has work to do.
let loadedVersion: string | undefined;
let cliPath: string | undefined;

// Every SDK value the daemon calls, read through here rather than via a direct import.
export const sdk = (): ClaudeSdk => current;

// Binary the loaded SDK should spawn (pathToClaudeCodeExecutable). Absent for the image copy, whose own resolution is
// already correct; present for a store copy, so the path is chosen and logged, not inferred.
export const claudeCliPath = (): string | undefined => cliPath;

export interface ClaudeSdkStatus {
    readonly source: "image" | "store";
    readonly version?: string;
}

const claudeSdkStatus = (): ClaudeSdkStatus => (loadedVersion === undefined ? { source: "image" } : { source: "store", version: loadedVersion });

const useBaked = (): ClaudeSdkStatus => {
    current = baked;
    loadedVersion = undefined;
    cliPath = undefined;
    return { source: "image" };
};

// Points this process at whatever the store says now. Called at boot and each turn's start; a no-op when the answer
// hasn't moved.
export const refreshClaudeSdk = async (): Promise<ClaudeSdkStatus> => {
    const resolved = await resolveEngine("claude");
    if (resolved.source === "image" || resolved.version === undefined || resolved.paths.jsEntry === undefined) {
        return loadedVersion === undefined ? claudeSdkStatus() : useBaked();
    }
    if (resolved.version === loadedVersion) {
        return claudeSdkStatus();
    }
    try {
        const loaded = (await import(pathToFileURL(resolved.paths.jsEntry).href)) as ClaudeSdk;
        // Re-checks what install-time verification already asked, covering a copy that has since lost a file.
        const missing = CLAUDE_SDK_EXPORTS.filter((name) => (loaded as unknown as Record<string, unknown>)[name] === undefined);
        if (missing.length > 0) {
            throw new Error(`does not export ${missing.join(", ")}`);
        }
        current = loaded;
        loadedVersion = resolved.version;
        cliPath = resolved.paths.binPath;
        return claudeSdkStatus();
    } catch (error) {
        // Refused permanently rather than retried, or the same failed import would be paid and logged every turn.
        await quarantineVersion("claude", resolved.version, errorMessage(error), new Date().toISOString());
        return useBaked();
    }
};

// Test seam: clears what this process loaded, so a suite can move the store between cases. Production never calls it.
export const forgetClaudeSdk = (): void => {
    useBaked();
};
