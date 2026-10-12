import type { HookCallback, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { BoundedMap } from "@intentic/base/held";
import { agentCommand, commandWords, toolResultText } from "../../providers/agent-installs.js";

// One line under a command's output when that output shows a failure whose cause is not in the code the agent is
// reading: a package's dist older than its source, or a GitHub token placeholder sent past the credential gateway. Both
// were long false leads in agents' own debugging sessions. Each is said once per conversation and subject, so a retry
// loop is not handed the same line every time.

const STALENESS = "node _tools/scripts/build/dist-staleness.mjs";
const REBUILD = "node _tools/scripts/build/emit-declarations.mjs";

// Programs whose output can carry a type checker's or a runtime's own error, as opposed to a search through a log
// that quotes one.
const RUNNERS = new Set(["node", "bun", "bunx", "tsx", "tsc", "vue-tsc", "vite", "vitest", "suites", "npx", "npm", "pnpm", "yarn", "turbo", "nx"]);

const executables = (command: string): string[] =>
    commandWords(agentCommand(command)).flatMap((invocation) => {
        const executable = invocation[0]?.split("/").at(-1);
        return executable === undefined ? [] : [executable];
    });

// A stale-dist symptom in the output, with the package it points at: an `@intentic/…` specifier, or the directory above
// a `/dist/` path. `target` is undefined when the output names only the symptom, and the notice then says `<pkg dir>`.
export const staleDistSymptom = (output: string): { readonly target: string | undefined } | undefined => {
    const builtFrom = /Output file ['"]([^'"\n]+?)\/dist\/[^'"\n]*['"] has not been built from source/u.exec(output);
    if (builtFrom !== null || /\bTS6305\b|has not been built from source/u.test(output)) {
        return { target: builtFrom?.[1] };
    }
    const member = /Module ['"]{1,2}(@intentic\/[^'"\s/]+)[^'"\s]*['"]{1,2} has no exported member/u.exec(output);
    const missing = /Cannot find module ['"](@intentic\/[^'"\s/]+)[^'"\s]*['"]/u.exec(output);
    // Bun's runtime wording for an import a built file does not export.
    const exportNamed = /Export named ['"][^'"\n]+['"] not found in module ['"]([^'"\n]+?)\/dist\/[^'"\n]*['"]/u.exec(output);
    const target = member?.[1] ?? missing?.[1] ?? exportNamed?.[1];
    return target === undefined ? undefined : { target };
};

export const staleDistNotice = (target: string | undefined): string =>
    `That error is the usual sign of a package's dist being older than its source, not of the code: check with ` +
    `\`${STALENESS} --for ${target ?? "<pkg dir>"}\` and rebuild declarations with \`${REBUILD}\`.`;

// `$GITHUB_TOKEN_<CONN>` or `${GITHUB_TOKEN_<CONN>}`: the connection's name, as the gateway variables spell it.
const TOKEN_VARIABLE = /\$\{?GITHUB_TOKEN_([A-Z0-9_]+)\}?/u;

// Undefined unless the command sent a gateway token placeholder somewhere other than the gateway and GitHub refused it.
export const placeholderConnection = (command: string, output: string): string | undefined => {
    const connection = TOKEN_VARIABLE.exec(command)?.[1];
    if (connection === undefined || !/Bad credentials/u.test(output) || command.includes("GITHUB_API_URL_")) {
        return undefined;
    }
    const toGitHub = command.includes("api.github.com") || output.includes("api.github.com") || executables(command).includes("gh");
    return toGitHub ? connection : undefined;
};

export const placeholderNotice = (connection: string): string =>
    `\`$GITHUB_TOKEN_${connection}\` holds a placeholder that only the local credential gateway swaps for the real token, ` +
    `so api.github.com answers 401. Send the request to \`$GITHUB_API_URL_${connection}\` instead, e.g. ` +
    `\`curl -s -H "Authorization: Bearer $GITHUB_TOKEN_${connection}" "$GITHUB_API_URL_${connection}/repos/<owner>/<repo>"\`.`;

// Conversations keep their SDK session id across resumed turns, so a subject told in one turn stays told in the next.
// Bounded: the oldest conversation's memory goes first, and the worst that costs is one repeated line.
const REMEMBERED_SESSIONS = 200;
const toldBySession = new BoundedMap<string, Set<string>>(REMEMBERED_SESSIONS);

const firstTelling = (session: string, subject: string): boolean => {
    let told = toldBySession.get(session);
    if (told === undefined) {
        told = new Set();
        toldBySession.set(session, told);
    }
    if (told.has(subject)) {
        return false;
    }
    told.add(subject);
    return true;
};

const outputNotices: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") {
        return {};
    }
    const command = (input.tool_input as { command?: unknown }).command;
    if (typeof command !== "string") {
        return {};
    }
    const output = toolResultText(input.tool_response);
    const lines: string[] = [];
    const connection = placeholderConnection(command, output);
    if (connection !== undefined && firstTelling(input.session_id, `github-placeholder\0${connection}`)) {
        lines.push(placeholderNotice(connection));
    }
    if (executables(command).some((executable) => RUNNERS.has(executable))) {
        const symptom = staleDistSymptom(output);
        if (symptom !== undefined && firstTelling(input.session_id, `stale-dist\0${symptom.target ?? ""}`)) {
            lines.push(staleDistNotice(symptom.target));
        }
    }
    return lines.length === 0 ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: lines.join("\n") } };
};

export const outputNoticeMatcher = (): HookCallbackMatcher => ({ matcher: "Bash", hooks: [outputNotices] });
