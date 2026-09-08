import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { type NamedSecret, surfaceForms } from "../../secrets/secret-registry.js";
import { maskDeep, maskTargets, redactionHooks, unmaskableSecrets } from "./agent-redaction.js";

// Masking must not depend on which tool fetched the value (it used to be Bash-only); a value masks to
// `{{secret:name}}`, which the write path resolves back, so a read-then-rewrite round-trips.

const TOKEN = "mcp_tok_9f2b1c7e4a0d";
const PASSWORD = "Xk4!mQ2pRt7@wZ9aBc1_";

const named = (name: string, value: string): NamedSecret => ({ name, value, source: "capability" });

// Drives the hook as the harness does, with the real tool_input as well as tool_response, since the input decides
// whether the shape pass runs.
const fire = async (
    secrets: () => Promise<readonly NamedSecret[]>,
    toolName: string,
    toolResponse: unknown,
    toolInput: unknown = {},
): Promise<HookJSONOutput> => {
    const [matcher] = redactionHooks(secrets).PostToolUse!;
    const input = {
        hook_event_name: "PostToolUse",
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        tool_use_id: "t1",
    } as unknown as HookInput;
    return matcher!.hooks[0]!(input, "t1", { signal: new AbortController().signal });
};

const held =
    (...secrets: NamedSecret[]) =>
    async () =>
        secrets;

// What the model would be shown: the rewritten result when the hook replaced it, else the original.
const shown = (output: HookJSONOutput, original: unknown): unknown =>
    (output as { hookSpecificOutput?: { updatedToolOutput?: unknown } }).hookSpecificOutput?.updatedToolOutput ?? original;

test("a credential is masked to its reference whichever tool fetched it: the seam this closes", async () => {
    // The same secret in the three result shapes that used to disagree: a string, a nested object, an MCP array.
    const linear = held(named("linear/token", TOKEN));
    const bash = `TOKEN=${TOKEN}`;
    expect(shown(await fire(linear, "Bash", bash), bash)).toBe("TOKEN={{secret:linear/token}}");

    const read = { file: { filePath: "/work/.intentic/config/capabilities.json", content: `{"token":"${TOKEN}"}` } };
    expect(shown(await fire(linear, "Read", read), read)).toEqual({
        file: { filePath: "/work/.intentic/config/capabilities.json", content: '{"token":"{{secret:linear/token}}"}' },
    });

    const mcp = { content: [{ type: "text", text: `authorized with ${TOKEN}` }] };
    expect(shown(await fire(linear, "mcp__linear__search", mcp), mcp)).toEqual({
        content: [{ type: "text", text: "authorized with {{secret:linear/token}}" }],
    });
});

test("no matcher, so a tool nobody has written yet is covered too", () => {
    // A tool list here would be exactly the gap this closes; the matcher must stay absent to cover every tool.
    const [matcher] = redactionHooks(held(named("linear/token", TOKEN))).PostToolUse!;
    expect(matcher!.matcher).toBeUndefined();
});

test("keys are left alone: a field NAME is not a secret", async () => {
    // Blanking a key would corrupt structure without hiding anything; naming a credential isn't holding one.
    const result = { [TOKEN]: "value", note: `see ${TOKEN}` };
    expect(shown(await fire(held(named("linear/token", TOKEN)), "Read", result), result)).toEqual({
        [TOKEN]: "value",
        note: "see {{secret:linear/token}}",
    });
});

test("a multi-line credential is masked line by line, to the anonymous mask", async () => {
    // Each line is its own target: the reference would resolve to N copies of the key if stamped per line instead.
    const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\nAQEFAASCBKcwggSjAgEAAoIB\n-----END PRIVATE KEY-----";
    const result = { content: "key: MIIEvQIBADANBgkqhkiG9w0 and AQEFAASCBKcwggSjAgEAAoIB" };
    expect(shown(await fire(held(named("host/sshKey", key)), "Read", result), result)).toEqual({ content: "key: *** and ***" });
});

test("a multi-line credential appearing WHOLE masks to its reference", async () => {
    const key = "line-one-aaaaaaaaaa\nline-two-bbbbbbbbbb";
    const result = `conf:\n${key}\nend`;
    expect(shown(await fire(held(named("vpnbox/config", key)), "Bash", result), result)).toBe("conf:\n{{secret:vpnbox/config}}\nend");
});

// Exact-substring masking needs every form a credential can take registered too: an escaped payload and a URL-encoded
// password both leaked in full against a raw-only target.
test("a JSON-escaped credential is masked: the form a serialized payload carries", async () => {
    const password = 'pa"ss\\word-1234567890';
    const escaped = JSON.stringify(password).slice(1, -1);
    const result = `{"password":"${escaped}"}`;
    expect(shown(await fire(held(named("reddit/password", password)), "Bash", result), result)).toBe('{"password":"{{secret:reddit/password}}"}');
});

test("a percent-encoded credential is masked: the form a URL carries", async () => {
    const password = "Xk4!mQ2pRt7@wZ9aBc1_";
    const result = `curl "https://api.example.com/login?p=${encodeURIComponent(password)}"`;
    expect(shown(await fire(held(named("reddit/password", password)), "Bash", result), result)).toBe(
        'curl "https://api.example.com/login?p={{secret:reddit/password}}"',
    );
});

test("a multi-line key serialized onto one line is masked whole, by its escaped form", async () => {
    // Escaping makes the cross-line value contiguous again, so it masks to the reference, not per-line blanks.
    const key = "-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END KEY-----";
    const result = `{"key":"${JSON.stringify(key).slice(1, -1)}"}`;
    expect(shown(await fire(held(named("host/sshKey", key)), "Read", result), result)).toBe('{"key":"{{secret:host/sshKey}}"}');
});

test("an alphanumeric token registers no extra forms: encoding it changes nothing", () => {
    // The common case must not pay for three targets over one secret.
    expect(maskTargets([named("a/token", "cf_live_0011223344ff")])).toEqual([{ target: "cf_live_0011223344ff", replacement: "{{secret:a/token}}" }]);
});

test("the terminal lane derives the same surface forms as this one", async () => {
    // The terminal filter is a standalone script with no daemon behind it, so it carries its own copy of surfaceForms;
    // what matters is that the two never disagree.
    // Imported by URL: the filter is plain JS with no declarations a literal specifier would need.
    const cleaners = new URL("../../../bin/cleaners.mjs", import.meta.url).href;
    const { surfaceForms: terminalForms } = (await import(cleaners)) as { surfaceForms: (value: string) => string[] };
    for (const value of [
        'pa"ss\\word-1234567890',
        "Xk4!mQ2pRt7@wZ9aBc1_",
        "cf_live_0011223344ff",
        "-----BEGIN KEY-----\nMIIEvQ\n-----END KEY-----",
    ]) {
        expect(terminalForms(value)).toEqual([...surfaceForms(value)]);
    }
});

test("a value containing another is masked whole, not left with its tail showing", async () => {
    // Longest-first, or masking the short one first would leave a reference glued to the credential's remainder.
    const short = "abcdefghijkl";
    const long = `${short}_mnopqrstuv`;
    const result = `secret=${long}`;
    expect(shown(await fire(held(named("a/short", short), named("b/long", long)), "Bash", result), result)).toBe("secret={{secret:b/long}}");
});

test("a short value is left alone: masking it would black out ordinary output", async () => {
    // Below the length floor a value isn't distinctive enough to blank on sight: it would swallow ordinary text.
    const result = "port 8080 mode admin";
    expect(await fire(held(named("a/port", "8080"), named("b/user", "admin")), "Bash", result)).toEqual({});
});

test("nothing stored, or nothing matching, leaves the result untouched by reference", async () => {
    // An empty response, not a rewritten copy, is what keeps a large result from being cloned on every call.
    expect(await fire(held(), "Read", { file: { content: "ordinary source code" } })).toEqual({});
    expect(await fire(held(named("linear/token", TOKEN)), "Read", { file: { content: "ordinary source code" } })).toEqual({});
});

test("an unreadable vault leaves the result alone rather than failing the tool call", async () => {
    // An unreadable vault is a reason to skip masking, never to break the tool call that produced output.
    const failing = async (): Promise<readonly NamedSecret[]> => {
        throw new Error("EACCES");
    };
    expect(await fire(failing, "Read", { file: { content: `token ${TOKEN}` } })).toEqual({});
});

test("every credential the sandbox holds is masked, under any field name a connector invents", async () => {
    // Value masking, not name heuristics: these sit under keys no pattern would flag, yet the strings are stored.
    const result = { wireguard_blob: PASSWORD, someVendorField: TOKEN };
    expect(shown(await fire(held(named("linear/token", TOKEN), named("reddit/password", PASSWORD)), "Grep", result), result)).toEqual({
        wireguard_blob: "{{secret:reddit/password}}",
        someVendorField: "{{secret:linear/token}}",
    });
});

test("maskTargets dedupes, trims, drops the short ones and orders longest first", () => {
    expect(
        maskTargets([named("a", "  padded_credential  "), named("b", "padded_credential"), named("c", "short"), named("d", "aaaaaaaaaaaaaaaaaaaa")]),
    ).toEqual([
        { target: "aaaaaaaaaaaaaaaaaaaa", replacement: "{{secret:d}}" },
        { target: "padded_credential", replacement: "{{secret:a}}" },
    ]);
});

test("maskDeep returns the SAME reference when nothing matched", () => {
    // How the hook tells unchanged from rewritten without re-comparing a large result.
    const targets = maskTargets([named("linear/token", TOKEN)]);
    const value = { a: ["b", { c: "d" }] };
    expect(maskDeep(value, targets)).toBe(value);
    // A copy the moment anything matched, leaving the input untouched.
    const hit = { a: [`x${TOKEN}`] };
    expect(maskDeep(hit, targets)).not.toBe(hit);
    expect(hit.a[0]).toBe(`x${TOKEN}`);
});

test("non-string leaves survive the walk unchanged", () => {
    // A tool result carries numbers, booleans and nulls; the walk must not stringify them.
    const value = { n: 26170149, ok: true, nothing: null, missing: undefined };
    expect(maskDeep(value, maskTargets([named("a", "26170149aaaa")]))).toEqual(value);
});

// A value below the length floor is never registered as a target, so it's never masked, and nothing else distinguishes
// that from one that is covered; this closes that reporting gap.
test("unmaskableSecrets names the stored values the length floor leaves in the clear", () => {
    expect(
        unmaskableSecrets([named("identity/password", "Short1#"), named("github/token", "ghp_aaaaaaaaaaaaaaaaaaaa"), named("db/pin", "  1234  ")]),
    ).toEqual(["db/pin", "identity/password"]);
});

test("a value that clears the floor is not reported, and is genuinely masked", () => {
    const secrets = [named("linear/token", "aaaaaaaaaaaaaaaaaaaa")];
    expect(unmaskableSecrets(secrets)).toEqual([]);
    // The two halves agree: nothing reported unprotected is left unmasked.
    expect(maskTargets(secrets).length).toBeGreaterThan(0);
});

// An unregistered credential (a project's own dotenv) used to reach the model in full, since value masking only knows
// the registry. Masked now, but only when the call named a credential file, keeping the pattern off ordinary source.
const DOTENV = "PORT=3000\nSTRIPE_SECRET=sk_live_51H8xQzRvKpLmNbTy\n";

test("a credential the sandbox has never stored is masked when the call named a credential file", async () => {
    const result = { file: { filePath: "/work/app/.env", content: DOTENV } };
    expect(shown(await fire(held(), "Read", result, { file_path: "/work/app/.env" }), result)).toEqual({
        file: { filePath: "/work/app/.env", content: "PORT=3000\nSTRIPE_SECRET=***\n" },
    });
});

test("the same file through the shell, by the same rule", async () => {
    expect(shown(await fire(held(), "Bash", DOTENV, { command: "cat .env" }), DOTENV)).toBe("PORT=3000\nSTRIPE_SECRET=***\n");
});

// Matching on the key alone once rewrote `oauthToken === undefined` mid-comparison and a token-count field in a JSON
// body; this pass keys on what the call named, not on the text it returned.
test("ordinary source is left alone: the pass keys on the call, not on the text", async () => {
    const source = { file: { filePath: "/work/src/auth.ts", content: 'if (oauthToken === undefined) throw new Error("no token");\n' } };
    expect(await fire(held(), "Read", source, { file_path: "/work/src/auth.ts" })).toEqual({});
    const usage = { content: '{"cacheReadTokens":26170149,"outputTokens":94746}' };
    expect(await fire(held(), "Read", usage, { file_path: "/work/src/usage.json" })).toEqual({});
});

// The classifier tells a search pattern from a path (sandbox-contract command-classes.ts): grepping for
// `process\.env\.` neither arms this pass nor blanks its own results.
test("a search whose pattern merely looks like a credential path does not arm the pass", async () => {
    const hits = { content: "src/config.ts:12: const token = process.env.GITHUB_TOKEN ?? throwMissing();" };
    expect(await fire(held(), "Grep", hits, { pattern: String.raw`process\.env\.`, path: "/work" })).toEqual({});
});

test("the two passes compose: what is stored keeps its reference, what is not is blanked", async () => {
    // A registered value masks to a reference; an unregistered one nearby is only blanked, never guessed.
    const content = `NPM_TOKEN=${TOKEN}\nSTRIPE_SECRET=sk_live_51H8xQzRvKpLmNbTy\n`;
    const result = { file: { content } };
    expect(shown(await fire(held(named("npm/token", TOKEN)), "Read", result, { file_path: "/work/.env" }), result)).toEqual({
        file: { content: "NPM_TOKEN={{secret:npm/token}}\nSTRIPE_SECRET=***\n" },
    });
});
