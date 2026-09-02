import { pathToFileURL } from "node:url";
import * as baked from "@anthropic-ai/claude-agent-sdk";
import { errorMessage } from "@intentic/base/errors";
import { CLAUDE_SDK_EXPORTS } from "../engines/engine-descriptors.js";
import { resolveEngine } from "../engines/engine-resolve.js";
import { quarantineVersion } from "../engines/engine-store.js";

/* WHERE THE CLAUDE CODE SDK COMES FROM AT RUNTIME, and why nothing in this daemon imports it directly.
 *
 * The SDK ships as a matched pair: the JavaScript half this process calls (`query`, the MCP tool builders, the
 * session readers) and the ~300 MB `claude` binary it spawns. Both are published as one npm version, and both
 * used to be frozen into the image, which made an upstream event — Anthropic raising the version floor a model
 * requires — a fleet-wide outage that only a new image could end.
 *
 * So the pair is loaded from the engine store when it holds a version, and from the image otherwise. Loading
 * BOTH halves from the same installed prefix is the point: a store binary under an image SDK (or the reverse)
 * is a combination nobody upstream has ever run, and this file exists partly to make that state unreachable.
 *
 * WHY A SYNC ACCESSOR OVER AN ASYNC IMPORT AT EACH SITE. Seventeen call sites want SDK values, and several of
 * them (the MCP tool servers) are built inside option construction that is not async. So the module is resolved
 * at two async moments — daemon boot, and the start of each turn — into a binding every site reads
 * synchronously. Within a turn the answer cannot change under it, which is what keeps `query`, the tool
 * builders and the servers they return all coming from ONE copy of the SDK.
 *
 * A NEW VERSION LANDS ON THE NEXT TURN, never mid-turn: a turn in flight holds the module it loaded, its
 * spawned CLI, and its open MCP servers. Node caches by resolved URL, so a version bump is a new URL and a
 * genuinely fresh module rather than a cached one; the outgoing copy stays loaded until the process exits,
 * which costs a couple of megabytes and buys turns that cannot be pulled apart underneath a user.
 *
 * THE IMAGE'S COPY IS IMPORTED STATICALLY AND IS THE FALLBACK FOR EVERYTHING. A store copy that will not
 * import is quarantined here (the same verdict engine-install.ts reaches before ever activating a version) and
 * the daemon keeps serving turns on the image's copy. The failure mode of this whole mechanism is a sandbox
 * that behaves exactly as it did before the mechanism existed. */

export type ClaudeSdk = typeof baked;

let current: ClaudeSdk = baked;
// The store version whose module is loaded, absent while the image's copy is in use. Not derived from the
// store on the fly: it is a record of what this PROCESS has actually imported, which is the question that
// decides whether a refresh has any work to do.
let loadedVersion: string | undefined;
let cliPath: string | undefined;

// Every SDK value the daemon calls, read through here. The alternative — seventeen `import` statements —
// is what tied the whole daemon to one copy of the SDK in the first place.
export const sdk = (): ClaudeSdk => current;

/* The binary the loaded SDK should spawn, handed to `query` as pathToClaudeCodeExecutable. Absent means the
 * image's copy, where the SDK's own resolution is already correct and naming a path would only be a second
 * chance to get it wrong. Present for a store copy, so what runs is a path this daemon chose and can log,
 * rather than one inferred from wherever the loaded module happens to sit. */
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

/* Point this process at whatever the store says now. Called at boot and at the start of every turn; a no-op
 * (one cached resolve, no import) whenever the answer has not moved, which is nearly always. */
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
        // The install-time verification asked this same question; asking it again here covers the copy that
        // was fine when installed and has since lost a file, and costs one property read per version change.
        const missing = CLAUDE_SDK_EXPORTS.filter((name) => (loaded as unknown as Record<string, unknown>)[name] === undefined);
        if (missing.length > 0) {
            throw new Error(`does not export ${missing.join(", ")}`);
        }
        current = loaded;
        loadedVersion = resolved.version;
        cliPath = resolved.paths.binPath;
        return claudeSdkStatus();
    } catch (error) {
        /* A copy that cannot be imported can never serve a turn, so it is refused permanently rather than
         * retried at the top of every turn: without the quarantine this failure would be paid, and logged,
         * once per turn forever. */
        await quarantineVersion("claude", resolved.version, errorMessage(error), new Date().toISOString());
        return useBaked();
    }
};

// Test seam: forget what this process loaded so a suite can move the store between cases. Production never
// calls it — a refresh already re-asks the store.
export const forgetClaudeSdk = (): void => {
    useBaked();
};
