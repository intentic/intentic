import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as baked from "@anthropic-ai/claude-agent-sdk";
import { errorMessage } from "@intentic/base/errors";
import { CLAUDE_SDK_EXPORTS, claudeBinaryNames } from "./engine-descriptors.js";
import { resolveEngine } from "./engine-resolve.js";
import { quarantineVersion } from "./engine-store.js";

// The Claude Code SDK (JS + ~300MB CLI binary) loads together from one prefix, engine store or image, since a
// mismatched pair has never run upstream. Resolved into a synchronous binding at boot and at each turn's start, so a
// bad store copy quarantines and falls back to the image.

export type ClaudeSdk = typeof baked;

// The image copy's binary, found from the SDK's own directory the way the SDK finds it; undefined where the image
// carries no variant this platform runs, which leaves the pick to the SDK.
const findImageBinary = (): string | undefined => {
    const fromSdk = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    for (const name of claudeBinaryNames()) {
        try {
            return fromSdk.resolve(name);
        } catch {
            // silent-catch: a variant this install does not carry does not resolve, and the next one is tried.
        }
    }
    return undefined;
};

// Every session a copy opens names its binary: the SDK's own pick calls process.report.getReport(), which waits for
// each worker thread to answer and held the loop 8 s at boot while one sat in a SQLite statement.
const namingBinary = (loaded: ClaudeSdk, binary: string | undefined): ClaudeSdk => {
    if (binary === undefined) {
        return loaded;
    }
    const query: ClaudeSdk["query"] = (params) => loaded.query({ ...params, options: { ...params.options, pathToClaudeCodeExecutable: binary } });
    // A proxy, not a copy: every other export stays the module's live binding, which a mocked module rebinds.
    return new Proxy(loaded, { get: (target, key) => (key === "query" ? query : Reflect.get(target, key)) });
};

const imageBinary = findImageBinary();
const image = namingBinary(baked, imageBinary);

let current: ClaudeSdk = image;
// Store version actually imported by this process, not derived live; decides whether a refresh has work to do.
let loadedVersion: string | undefined;
let cliPath: string | undefined = imageBinary;

// Every SDK value the daemon calls, read through here rather than via a direct import.
export const sdk = (): ClaudeSdk => current;

// The binary every session of the loaded copy spawns.
export const claudeCliPath = (): string | undefined => cliPath;

export interface ClaudeSdkStatus {
    readonly source: "image" | "store";
    readonly version?: string;
}

const claudeSdkStatus = (): ClaudeSdkStatus => (loadedVersion === undefined ? { source: "image" } : { source: "store", version: loadedVersion });

const useBaked = (): ClaudeSdkStatus => {
    current = image;
    loadedVersion = undefined;
    cliPath = imageBinary;
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
        current = namingBinary(loaded, resolved.paths.binPath);
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
