import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { type NamedSecret, surfaceForms } from "../secrets/secret-registry.js";
import { maskDeep, maskTargets, redactionHooks, unmaskableSecrets } from "./agent-redaction.js";

/* THE PROMISE THIS KEEPS: a credential this sandbox stores never reaches the model, no matter which tool went
 * and got it. The bug these pin is not "masking is broken": it is that masking used to be a property of the
 * BASH LANE, so `cat config.json` came back masked and `Read` of the same file did not. Every test below that
 * names a tool is really asserting the absence of that seam.
 *
 * A value masks TO ITS REFERENCE: `{{secret:name}}`, what the write path resolves back, so a config the
 * model reads and rewrites round-trips instead of coming back with a blank pasted over the credential. */

const TOKEN = "mcp_tok_9f2b1c7e4a0d";
const PASSWORD = "Xk4!mQ2pRt7@wZ9aBc1_";

const named = (name: string, value: string): NamedSecret => ({ name, value, source: "capability" });

// Drive the hook the way the harness does, with a tool result of that tool's own shape. The INPUT matters as
// well as the output now: it is what decides whether the shape pass runs (see the block at the end).
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
    // The same secret, in the three result shapes that used to disagree: Bash's string, Read's nested object,
    // an MCP server's content array.
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
    // A tool LIST here would be a list of the tools somebody remembered: the exact shape of the gap this exists
    // to close. The matcher must stay absent.
    const [matcher] = redactionHooks(held(named("linear/token", TOKEN))).PostToolUse!;
    expect(matcher!.matcher).toBeUndefined();
});

test("keys are left alone: a field NAME is not a secret", async () => {
    // Blanking a key would corrupt the structure without hiding anything, and a file that merely MENTIONS a
    // credential's name is documentation.
    const result = { [TOKEN]: "value", note: `see ${TOKEN}` };
    expect(shown(await fire(held(named("linear/token", TOKEN)), "Read", result), result)).toEqual({
        [TOKEN]: "value",
        note: "see {{secret:linear/token}}",
    });
});

test("a multi-line credential is masked line by line, to the anonymous mask", async () => {
    // An ssh key or a WireGuard conf rarely survives as one run of text once it is inside a JSON string, so
    // each line is its own target, but NOT to the reference: a reference stands for the whole value, and
    // stamping it per line would make the masked block resolve to N copies of the key.
    const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\nAQEFAASCBKcwggSjAgEAAoIB\n-----END PRIVATE KEY-----";
    const result = { content: "key: MIIEvQIBADANBgkqhkiG9w0 and AQEFAASCBKcwggSjAgEAAoIB" };
    expect(shown(await fire(held(named("host/sshKey", key)), "Read", result), result)).toEqual({ content: "key: *** and ***" });
});

test("a multi-line credential appearing WHOLE masks to its reference", async () => {
    const key = "line-one-aaaaaaaaaa\nline-two-bbbbbbbbbb";
    const result = `conf:\n${key}\nend`;
    expect(shown(await fire(held(named("vpnbox/config", key)), "Bash", result), result)).toBe("conf:\n{{secret:vpnbox/config}}\nend");
});

/* THE FORM A CREDENTIAL ARRIVES IN is not the form this sandbox stores it in, and exact-substring masking is
 * only complete once every form is registered. Both cases below leaked the value in full against raw-only
 * targets, and both are ordinary rather than exotic: a serialized payload escapes quotes and backslashes, and
 * a URL encodes every symbol in a generated password. */
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
    // The escaped form makes a value that only ever appeared across lines contiguous again, so it masks to the
    // reference rather than to the per-line blanks.
    const key = "-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END KEY-----";
    const result = `{"key":"${JSON.stringify(key).slice(1, -1)}"}`;
    expect(shown(await fire(held(named("host/sshKey", key)), "Read", result), result)).toBe('{"key":"{{secret:host/sshKey}}"}');
});

test("an alphanumeric token registers no extra forms: encoding it changes nothing", () => {
    // The common case must not pay three targets for one secret.
    expect(maskTargets([named("a/token", "cf_live_0011223344ff")])).toEqual([{ target: "cf_live_0011223344ff", replacement: "{{secret:a/token}}" }]);
});

test("the terminal lane derives the same surface forms as this one", async () => {
    /* The two masking lanes each carry their own copy: the terminal filter runs as a standalone script with
     * no daemon behind it, so the thing worth pinning is that they agree. A form one lane registers and the
     * other does not is a credential that is masked when fetched with Read and shown when fetched with `cat`,
     * which is exactly the seam this whole mechanism exists to close. */
    // Imported by URL rather than by literal path: the filter is plain JS with no declarations, and a literal
    // specifier would make the type checker demand them for a module this test only calls one function of.
    const cleaners = new URL("../../bin/cleaners.mjs", import.meta.url).href;
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
    // Longest-first ordering. Masking the short one first would leave a reference glued to a remainder that is
    // still part of a credential.
    const short = "abcdefghijkl";
    const long = `${short}_mnopqrstuv`;
    const result = `secret=${long}`;
    expect(shown(await fire(held(named("a/short", short), named("b/long", long)), "Bash", result), result)).toBe("secret={{secret:b/long}}");
});

test("a short value is left alone: masking it would black out ordinary output", async () => {
    // Below the 12-character floor a "credential" is not distinctive enough to blank on sight: `true`, `admin`
    // or `8080` would swallow unrelated text everywhere they appear.
    const result = "port 8080 mode admin";
    expect(await fire(held(named("a/port", "8080"), named("b/user", "admin")), "Bash", result)).toEqual({});
});

test("nothing stored, or nothing matching, leaves the result untouched by reference", async () => {
    // The overwhelmingly common case. An empty response (rather than a rewritten copy) is what keeps a large
    // tool result from being cloned on every single tool call.
    expect(await fire(held(), "Read", { file: { content: "ordinary source code" } })).toEqual({});
    expect(await fire(held(named("linear/token", TOKEN)), "Read", { file: { content: "ordinary source code" } })).toEqual({});
});

test("an unreadable vault leaves the result alone rather than failing the tool call", async () => {
    // A vault that cannot be read is a reason to skip masking, never to break the tool that produced the output.
    const failing = async (): Promise<readonly NamedSecret[]> => {
        throw new Error("EACCES");
    };
    expect(await fire(failing, "Read", { file: { content: `token ${TOKEN}` } })).toEqual({});
});

test("every credential the sandbox holds is masked, under any field name a connector invents", async () => {
    // Value masking, not name heuristics: the two secrets below sit under keys no pattern would flag, and are
    // still masked because these are strings this sandbox actually stores.
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
    // How the hook tells "unchanged" from "rewritten" without re-comparing a large result.
    const targets = maskTargets([named("linear/token", TOKEN)]);
    const value = { a: ["b", { c: "d" }] };
    expect(maskDeep(value, targets)).toBe(value);
    // And a copy the moment anything did, leaving the input untouched.
    const hit = { a: [`x${TOKEN}`] };
    expect(maskDeep(hit, targets)).not.toBe(hit);
    expect(hit.a[0]).toBe(`x${TOKEN}`);
});

test("non-string leaves survive the walk unchanged", () => {
    // A tool result carries numbers, booleans and nulls; the walk must not stringify them.
    const value = { n: 26170149, ok: true, nothing: null, missing: undefined };
    expect(maskDeep(value, maskTargets([named("a", "26170149aaaa")]))).toEqual(value);
});

/* The floor's blind spot, named rather than left to be discovered in a transcript. A stored value below
 * MIN_LENGTH is never registered as a target, so it is never masked, and nothing about the vault, the Secrets
 * page or the mask itself distinguishes that from a value that IS covered. These two pin the reporting that
 * closes the gap: long values are protected and stay silent, short ones are called out by name. */
test("unmaskableSecrets names the stored values the length floor leaves in the clear", () => {
    expect(
        unmaskableSecrets([named("identity/password", "Short1#"), named("github/token", "ghp_aaaaaaaaaaaaaaaaaaaa"), named("db/pin", "  1234  ")]),
    ).toEqual(["db/pin", "identity/password"]);
});

test("a value that clears the floor is not reported, and is genuinely masked", () => {
    const secrets = [named("linear/token", "aaaaaaaaaaaaaaaaaaaa")];
    expect(unmaskableSecrets(secrets)).toEqual([]);
    // The two halves agree: nothing reported unprotected is left unmasked, which is what makes the report
    // worth reading rather than a second list to reconcile by hand.
    expect(maskTargets(secrets).length).toBeGreaterThan(0);
});

/* THE SECOND PASS, and the whole reason the command gate stopped asking about reads (guard/actions.ts): a
 * credential this sandbox does NOT store — the project's own dotenv, a token minted an hour ago — used to reach
 * the model in full through every lane, because value masking only knows the registry. It is masked now, but
 * only where the CALL named a credential file, which is what keeps the same patterns off ordinary source. */
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

/* THE INPUT THIS PASS MUST NOT FIRE ON, and the measurements are in the module header: matching on the key
 * alone rewrote `oauthToken === undefined` mid-comparison and broke a JSON body at `"cacheReadTokens":26170149`.
 * A Read of source code is exactly that input, and it stays untouched because the call named source code. */
test("ordinary source is left alone: the pass keys on the call, not on the text", async () => {
    const source = { file: { filePath: "/work/src/auth.ts", content: 'if (oauthToken === undefined) throw new Error("no token");\n' } };
    expect(await fire(held(), "Read", source, { file_path: "/work/src/auth.ts" })).toEqual({});
    const usage = { content: '{"cacheReadTokens":26170149,"outputTokens":94746}' };
    expect(await fire(held(), "Read", usage, { file_path: "/work/src/usage.json" })).toEqual({});
});

/* A GREP FOR A CREDENTIAL-SHAPED NAME IS NOT A READ OF ONE. The classifier tells a pattern from a path
 * (sandbox-contract command-classes.ts), so searching the workspace for `process\.env\.` neither raises a card nor
 * turns this pass on and blanks the search results. */
test("a search whose pattern merely looks like a credential path does not arm the pass", async () => {
    const hits = { content: "src/config.ts:12: const token = process.env.GITHUB_TOKEN ?? throwMissing();" };
    expect(await fire(held(), "Grep", hits, { pattern: String.raw`process\.env\.`, path: "/work" })).toEqual({});
});

test("the two passes compose: what is stored keeps its reference, what is not is blanked", async () => {
    // A registry value masks to a token the exits resolve back; an unregistered one beside it can only be
    // blanked, because a guess must not mint a reference that promises to resolve.
    const content = `NPM_TOKEN=${TOKEN}\nSTRIPE_SECRET=sk_live_51H8xQzRvKpLmNbTy\n`;
    const result = { file: { content } };
    expect(shown(await fire(held(named("npm/token", TOKEN)), "Read", result, { file_path: "/work/.env" }), result)).toEqual({
        file: { content: "NPM_TOKEN={{secret:npm/token}}\nSTRIPE_SECRET=***\n" },
    });
});
