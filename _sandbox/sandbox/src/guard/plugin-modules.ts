import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HookModule } from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/base/errors";

/* What a plugin's hooks module does, as Claude Code itself reads it without running it: `claude plugin validate <dir>
 * --json` notes, per module, the events it hooks and the methods of `$` it calls. The approval card shows both. Only
 * read when a turn first files a set (the stored request keeps it, so the digest is the cache), and never a reason to
 * hold or release anything: a failure is said on the card instead. */

export type ModuleSummary = Omit<HookModule, "path">;

// Reads one module: the plugin's directory as the daemon opens it, and the module as its hooks.json names it.
export type ModuleReader = (dir: string, module: string) => Promise<ModuleSummary>;

const run = promisify(execFile);

// A hung check must not hold a turn's start for long; the card says it could not be read.
const VALIDATE_TIMEOUT_MS = 20_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// A note's list, split at the commas outside a matcher's braces (`tool.call{tool=Bash|Edit}, session.start`).
const listOf = (text: string): string[] => {
    const items: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of text) {
        depth += char === "{" ? 1 : char === "}" ? -1 : 0;
        if (char === "," && depth === 0) {
            items.push(current.trim());
            current = "";
            continue;
        }
        current += char;
    }
    items.push(current.trim());
    return items.filter((item) => item !== "");
};

// The JSON `claude plugin validate --json` prints, read for one module: its `hooks:` and `calls:` notes, else why not.
export const moduleSummaryOf = (output: unknown, module: string): ModuleSummary => {
    const contents = isRecord(output) && Array.isArray(output["contents"]) ? output["contents"].filter(isRecord) : [];
    const hooksFiles = contents.filter((content) => content["type"] === "hooks");
    const notes = hooksFiles.flatMap((content) => (Array.isArray(content["notes"]) ? content["notes"].filter((note: unknown) => typeof note === "string") : []));
    const note = (kind: string): string[] | undefined => {
        const prefix = `${module} ${kind}:`;
        const found = notes.find((line) => line.startsWith(prefix));
        return found === undefined ? undefined : listOf(found.slice(prefix.length));
    };
    const hooks = note("hooks");
    if (hooks !== undefined) {
        return { hooks, calls: note("calls") ?? [] };
    }
    const errors = hooksFiles.flatMap((content) =>
        Array.isArray(content["errors"]) ? content["errors"].flatMap((error: unknown) => (isRecord(error) && typeof error["message"] === "string" ? [error["message"]] : [])) : [],
    );
    return { hooks: [], calls: [], unreadable: errors.length > 0 ? errors.join("; ") : "Claude Code's plugin check did not describe it" };
};

// The reader over the pinned CLI binary (engines/claude-sdk.ts finds it). The check runs with no credential in its
// environment: it reads files, and the module it reads is the code nobody approved yet.
export const claudeModuleReader =
    (cli: string | undefined): ModuleReader =>
    async (dir, module) => {
        if (cli === undefined) {
            return { hooks: [], calls: [], unreadable: "this sandbox's Claude Code was not found" };
        }
        let stdout: string;
        try {
            stdout = (await run(cli, ["plugin", "validate", dir, "--json"], { cwd: dir, timeout: VALIDATE_TIMEOUT_MS, env: cleanEnv() })).stdout;
        } catch (error) {
            // A plugin that fails the check exits non-zero and still prints its report.
            const printed = isRecord(error) && typeof error["stdout"] === "string" ? error["stdout"] : "";
            if (printed.trim() === "") {
                return { hooks: [], calls: [], unreadable: `Claude Code's plugin check failed (${errorMessage(error)})` };
            }
            stdout = printed;
        }
        try {
            return moduleSummaryOf(JSON.parse(stdout), module);
        } catch {
            return { hooks: [], calls: [], unreadable: "Claude Code's plugin check printed something this sandbox could not read" };
        }
    };

const cleanEnv = (): NodeJS.ProcessEnv => {
    const { PATH, HOME, LANG } = process.env;
    return { ...(PATH === undefined ? {} : { PATH }), ...(HOME === undefined ? {} : { HOME }), ...(LANG === undefined ? {} : { LANG }) };
};
