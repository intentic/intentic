import { join } from "node:path";
import { parseCleaners } from "@intentic/output-cleaners/cleaners";
import { filterRun } from "@intentic/output-cleaners/filter";
import { readOptions } from "./features.js";
import { dataDir, type Env, type HookInput, projectDir, runHook } from "./hook-io.js";

// PostToolUse on Bash: the command's output, trimmed by the sandbox's own cleaners before Claude reads it, with the raw
// text kept where the footer's `retrieve-output` finds it and one ledger row per command for /intentic:stats. Claude
// Code runs this hook only for a command that succeeded; a failure reaches Claude whole, which is the same rule the
// sandbox holds (its failure path keeps the detail and only collapses long repeats).

// Where the plugin keeps the pass's raw-output/, output-cache/ and filter-stats.jsonl, for every project alike.
export const outputDir = (data: string): string => join(data, "output");

// The plugin's own reports are already budgeted for Claude to read whole; trimming them would cut the answer to the
// question the person just asked.
const OWN_REPORTS = /(?:^|[\s/])intentic-(?:stats|notes-evidence)(?:\s|$)/;

interface BashResponse {
    readonly stdout?: unknown;
    readonly stderr?: unknown;
    readonly interrupted?: unknown;
    readonly isImage?: unknown;
    readonly backgroundTaskId?: unknown;
}

// What the model would have read: stdout, then stderr after it, which is the order Claude Code shows them in.
const rawOf = (response: BashResponse): string | undefined => {
    if (typeof response.stdout !== "string" || response.interrupted === true || response.isImage === true || response.backgroundTaskId !== undefined) {
        return undefined;
    }
    const stderr = typeof response.stderr === "string" ? response.stderr : "";
    return stderr === "" ? response.stdout : `${response.stdout}${response.stdout === "" || response.stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
};

export const postBash = (input: HookInput, env: Env = process.env): object | undefined => {
    const options = readOptions(env);
    const command = input.tool_input?.["command"];
    const response = input.tool_response;
    if (!options.output_cleaners || typeof command !== "string" || OWN_REPORTS.test(command) || typeof response !== "object" || response === null) {
        return undefined;
    }
    const raw = rawOf(response);
    if (raw === undefined || raw === "") {
        return undefined;
    }
    const session = input.session_id ?? "session";
    const { out } = filterRun(raw, {
        command,
        exitCode: "0",
        durationS: String(Math.round((input.duration_ms ?? 0) / 1000)),
        enabled: parseCleaners(options.cleaners),
        holdout: options.output_holdout,
        logsDir: outputDir(dataDir(env)),
        // One file per call, named so a person can tell which session it came from.
        runName: `${session}-${input.tool_use_id ?? Date.now().toString(36)}.log`,
        sessionKey: session,
        values: [],
        tags: { project: projectDir(input, env), session },
    });
    if (out === raw) {
        return undefined;
    }
    // The rest of the tool's result (its own flags and fields) is kept as it came; Claude Code rejects a replacement
    // that does not match the tool's output shape and keeps the original, which is the fail-open this relies on.
    return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { ...response, stdout: out, stderr: "" } } };
};

if (process.argv[1]?.endsWith("post-bash.mjs")) {
    await runHook((input) => postBash(input));
}
