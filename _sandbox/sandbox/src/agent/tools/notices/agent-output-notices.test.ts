import { WORKSPACE_ROOT } from "@intentic/constants";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { syncHookOutput } from "../../run/harness/harness-hooks.testing.js";
import { depsNoticeHooks } from "./agent-deps.js";
import { outputNoticeMatcher, placeholderConnection, staleDistSymptom } from "./agent-output-notices.js";

let sessions = 0;
// Each test its own conversation: the latch is per conversation, and module-wide.
const freshSession = (): string => `session-${(sessions += 1)}`;

const fire = async (output: string, command: string, session: string) => {
    const input = {
        hook_event_name: "PostToolUse",
        session_id: session,
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: "", stderr: output },
        tool_use_id: "t1",
    } as unknown as HookInput;
    const result = await outputNoticeMatcher().hooks[0]!(input, "t1", { signal: new AbortController().signal });
    return (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
};

test.each([
    [
        "TS6305 with the dist path",
        `error TS6305: Output file '${WORKSPACE_ROOT}/intentic/_shared/constants/dist/index.d.ts' has not been built from source file '${WORKSPACE_ROOT}/intentic/_shared/constants/src/index.ts'.`,
        `${WORKSPACE_ROOT}/intentic/_shared/constants`,
    ],
    [
        "a missing export from a workspace package",
        `src/a.ts(1,10): error TS2305: Module '"@intentic/constants"' has no exported member 'QUEUE'.`,
        "@intentic/constants",
    ],
    [
        "a subpath of a workspace package",
        `error TS2307: Cannot find module '@intentic/constants/node' or its corresponding type declarations.`,
        "@intentic/constants",
    ],
    [
        "bun's runtime wording against a built file",
        `SyntaxError: Export named 'queueRoot' not found in module '${WORKSPACE_ROOT}/intentic/_shared/constants/dist/index.js'.`,
        `${WORKSPACE_ROOT}/intentic/_shared/constants`,
    ],
])("%s is read as a stale dist, naming the package", (_name, output, target) => {
    expect(staleDistSymptom(output)).toEqual({ target });
});

test("TS6305 without a path still counts, with the package left for the reader", () => {
    expect(staleDistSymptom("error TS6305: something about project references")).toEqual({ target: undefined });
});

test.each([
    ["an ordinary type error", `src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.`],
    ["a missing export from a relative module", `error TS2305: Module '"./util"' has no exported member 'x'.`],
    ["a missing third-party module", `Cannot find module 'vue'`],
    ["a missing export from a source file", `SyntaxError: Export named 'a' not found in module '${WORKSPACE_ROOT}/app/src/b.ts'.`],
])("%s is not a stale dist", (_name, output) => {
    expect(staleDistSymptom(output)).toBeUndefined();
});

test("a type check failing on a stale dist is pointed at the staleness check and the rebuild, once per package", async () => {
    const session = freshSession();
    const output = `error TS2305: Module '"@intentic/constants"' has no exported member 'QUEUE'.`;
    const told = await fire(output, "cd _sandbox/sandbox && pnpm typecheck", session);
    expect(told).toContain("node _tools/scripts/build/dist-staleness.mjs --for @intentic/constants");
    expect(told).toContain("node _tools/scripts/build/emit-declarations.mjs");
    expect(await fire(output, "cd _sandbox/sandbox && pnpm typecheck", session)).toBeUndefined();
    // A later turn of the same conversation was told already.
    expect(await fire(output, "bun check -p tsconfig.test.json", session)).toBeUndefined();
    // Another package is another subject, and another conversation has been told nothing.
    expect(await fire(`Cannot find module '@intentic/testing'`, "bun test", session)).toContain("--for @intentic/testing");
    expect(await fire(output, "pnpm typecheck", freshSession())).toEqual(expect.any(String));
});

test("searching a log that quotes the symptom is not running the check", async () => {
    expect(await fire(`has not been built from source`, "rg 'TS6305' build.log", freshSession())).toBeUndefined();
});

const BAD_CREDENTIALS = `{\n  "message": "Bad credentials",\n  "documentation_url": "https://docs.github.com/rest",\n  "status": "401"\n}`;

test.each([
    ["curl straight to api.github.com", `curl -s -H "Authorization: Bearer $GITHUB_TOKEN_GITHUB" https://api.github.com/repos/o/r`, BAD_CREDENTIALS],
    ["the braced form", `curl -s -H "Authorization: token \${GITHUB_TOKEN_WORK}" https://api.github.com/user`, BAD_CREDENTIALS],
    [
        "gh with the placeholder as its token",
        `GH_TOKEN=$GITHUB_TOKEN_GITHUB gh api repos/o/r`,
        "HTTP 401: Bad credentials (https://api.github.com/repos/o/r)",
    ],
])("a placeholder sent past the gateway is recognised: %s", (_name, command, output) => {
    expect(placeholderConnection(command, output)).toMatch(/^(GITHUB|WORK)$/u);
});

test.each([
    [
        "the request went through the gateway",
        `curl -s -H "Authorization: Bearer $GITHUB_TOKEN_GITHUB" "$GITHUB_API_URL_GITHUB/user"`,
        BAD_CREDENTIALS,
    ],
    ["no placeholder was used", `curl -s -H "Authorization: Bearer $MY_PAT" https://api.github.com/user`, BAD_CREDENTIALS],
    ["GitHub did not refuse it", `curl -s -H "Authorization: Bearer $GITHUB_TOKEN_GITHUB" https://api.github.com/user`, `{"login":"someone"}`],
])("no gateway notice when %s", (_name, command, output) => {
    expect(placeholderConnection(command, output)).toBeUndefined();
});

test("a 401 on the placeholder names the gateway variable with an example, once per conversation", async () => {
    const session = freshSession();
    const command = `curl -s -H "Authorization: Bearer $GITHUB_TOKEN_GITHUB" https://api.github.com/repos/o/r/actions/runs`;
    const told = await fire(BAD_CREDENTIALS, command, session);
    expect(told).toContain("$GITHUB_API_URL_GITHUB");
    expect(told).toContain(`curl -s -H "Authorization: Bearer $GITHUB_TOKEN_GITHUB" "$GITHUB_API_URL_GITHUB/repos/<owner>/<repo>"`);
    expect(await fire(BAD_CREDENTIALS, command, session)).toBeUndefined();
});

test("the notices ride on the dependency hooks, so a turn that has those has these", () => {
    const hooks = depsNoticeHooks(async () => undefined, true);
    expect(hooks.PostToolUse?.map((matcher) => matcher.matcher)).toEqual(["Bash", "Bash"]);
});
