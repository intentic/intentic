import { expect, test } from "vitest";
import { harnessEnv } from "./harness-credentials.js";

/* What a harness process is told about models, and the reason it matters beyond the turn's own `--model`: a
 * routed turn reaches a translator that serves ONE model, and every other model name the harness can resolve
 * (a subagent's "sonnet", the Task tool's default, the cheap tier) has to land on it or come back 502. */

test("a routed endpoint collapses every model tier onto the endpoint's own model", () => {
    const env = harnessEnv({ baseUrl: "http://127.0.0.1:8788", authToken: "local", model: "gpt-5.6-sol" });
    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:8788");
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("local");
    // The alias table the CLI resolves subagent + tier requests through.
    expect(env["ANTHROPIC_DEFAULT_OPUS_MODEL"]).toBe("gpt-5.6-sol");
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBe("gpt-5.6-sol");
    expect(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"]).toBe("gpt-5.6-sol");
    expect(env["ANTHROPIC_SMALL_FAST_MODEL"]).toBe("gpt-5.6-sol");
    expect(env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBe("gpt-5.6-sol");
    // The withholding rule: a subscription token never travels to a foreign endpoint.
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
});

test("a native Claude turn keeps the real alias table — sonnet and opus are different models there", () => {
    const env = harnessEnv({ oauthToken: "sk-oauth", model: "claude-opus-5" });
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-oauth");
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBeUndefined();
    expect(env["ANTHROPIC_DEFAULT_OPUS_MODEL"]).toBeUndefined();
    expect(env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBeUndefined();
});

test("every harness process is told to ride out a provider outage rather than give up on it", () => {
    // Whichever credential shape serves the turn: the retry budget is about the provider being down, which has
    // nothing to do with whose token is in play. A turn that gives up here is one turn-resume.ts has to rebuild
    // from scratch, at full context cost.
    for (const credentials of [{ oauthToken: "sk-oauth" }, { baseUrl: "http://127.0.0.1:8788", authToken: "local" }, {}]) {
        expect(harnessEnv(credentials)["CLAUDE_CODE_RETRY_WATCHDOG"]).toBe("1");
    }
});

test("a custom endpoint with no resolved model pins nothing rather than an empty id", () => {
    const env = harnessEnv({ baseUrl: "https://router.example", authToken: "local" });
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://router.example");
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBeUndefined();
    expect(env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBeUndefined();
});
