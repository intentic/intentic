import { type ProviderRefusal, TRIAL_ENDPOINT_ID, TRIAL_MODEL_ID } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import type { SeatRefusal } from "../claude/claude-seats.js";
import { memoryCapabilitiesStore, services, withTranslator } from "../route-testing.js";
import { harnessEnv, resolveHarnessCredentials } from "./harness-credentials.js";

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

test("a native Claude turn keeps the real alias table: sonnet and opus are different models there", () => {
    const env = harnessEnv({ oauthToken: "sk-oauth", model: "claude-opus-5" });
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-oauth");
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBeUndefined();
    expect(env["ANTHROPIC_DEFAULT_OPUS_MODEL"]).toBeUndefined();
    expect(env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBeUndefined();
});

test("every harness TURN is told to ride out a provider outage rather than give up on it", () => {
    // Whichever credential shape serves the turn: the retry budget is about the provider being down, which has
    // nothing to do with whose token is in play. A turn that gives up here is one turn-resume.ts has to rebuild
    // from scratch, at full context cost.
    for (const credentials of [{ oauthToken: "sk-oauth" }, { baseUrl: "http://127.0.0.1:8788", authToken: "local" }, {}]) {
        expect(harnessEnv(credentials)["CLAUDE_CODE_RETRY_WATCHDOG"]).toBe("1");
    }
});

test("a free-trial turn uses the platform's bounded key walk instead of the long harness watchdog", () => {
    const env = harnessEnv({ baseUrl: "http://127.0.0.1:8788", authToken: "local", model: "gemini-flash-latest", trial: true });
    expect(env["CLAUDE_CODE_RETRY_WATCHDOG"]).toBeUndefined();
    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:8788");
});

test("a free-trial turn resolves from constants: the synthetic model id, no catalog fetch, bounded policy", async () => {
    // `endpointModels` deliberately unstubbed: the trial's model is a known constant, so a resolution that
    // reaches for a catalog would throw here, which is the regression this pins. The fetch used to refuse
    // turns whenever the platform blipped, as "its model catalog could not be read".
    const sandbox = services({ config: withTranslator });
    await sandbox.capabilities.upsert({
        id: TRIAL_ENDPOINT_ID,
        kind: "endpoint",
        config: { baseUrl: "https://platform.test/trial/v1", protocol: "openai", apiKey: "connect-token" },
    });
    const result = await resolveHarnessCredentials(sandbox, { agent: `endpoint/${TRIAL_ENDPOINT_ID}`, model: "whatever-the-picker-held" });

    expect(result.ok && result.credentials.trial).toBe(true);
    // The one id the translator's static entry routes; the platform picks the real model per message.
    expect(result.ok && result.credentials.endpoint?.model).toBe(`${TRIAL_ENDPOINT_ID}/${TRIAL_MODEL_ID}`);
});

test("a trial turn on a cold availability cache re-probes once instead of refusing on an unanswered question", async () => {
    // Boot fires the availability probe without awaiting it, so a turn can arrive first. The capability layer
    // then hides the trial (available() false): the resolver must ask the platform on the turn's own clock
    // rather than turn the user away with "no longer available".
    let probed = 0;
    const store = memoryCapabilitiesStore();
    const sandbox = services({
        config: withTranslator,
        capabilities: {
            ...store,
            get: async (id) =>
                (await store.get(id)) ??
                (id === TRIAL_ENDPOINT_ID && probed > 0
                    ? { id: TRIAL_ENDPOINT_ID, kind: "endpoint", config: { baseUrl: "https://platform.test/trial/v1", protocol: "openai" } }
                    : undefined),
        },
        trial: {
            available: () => probed > 0,
            status: () => undefined,
            refresh: async () => {
                probed += 1;
            },
        },
    });
    const result = await resolveHarnessCredentials(sandbox, { agent: `endpoint/${TRIAL_ENDPOINT_ID}` });

    expect(probed).toBe(1);
    expect(result.ok && result.credentials.endpoint?.model).toBe(`${TRIAL_ENDPOINT_ID}/${TRIAL_MODEL_ID}`);
});

test("a HELPER is told the opposite, so a rung that will not answer is stepped over rather than waited out", () => {
    // The regression this pins: a one-shot inherited the turn's watchdog and therefore its three hundred
    // attempts, so the commit-message draft ground through a refusing rung for the better part of a minute
    // instead of failing over to the next model in the chain: the one thing the chain exists to do.
    for (const credentials of [{ oauthToken: "sk-oauth" }, { baseUrl: "http://127.0.0.1:8788", authToken: "local" }, {}]) {
        expect(harnessEnv({ ...credentials, helper: true })["CLAUDE_CODE_RETRY_WATCHDOG"]).toBeUndefined();
    }
    // Everything else about a helper's environment is a turn's: only the patience differs.
    expect(harnessEnv({ oauthToken: "sk-oauth", helper: true })["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-oauth");
    expect(harnessEnv({ helper: true })["IS_SANDBOX"]).toBe("1");
});

test("a custom endpoint with no resolved model pins nothing rather than an empty id", () => {
    const env = harnessEnv({ baseUrl: "https://router.example", authToken: "local" });
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://router.example");
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBeUndefined();
    expect(env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBeUndefined();
});

/* WHICH ACCOUNT AN UNNAMED TURN LANDS ON: every unattended run in the sandbox, since only a composer names one.
 *
 * The pick is by headroom, and headroom alone is exactly what an entitlement refusal defeats: an account the
 * organization has switched Claude Code off for is turned away before it spends a token, so its meter stays the
 * best-looking one on file and it wins every pick, forever. This is the layer that knows the turn's provider, so
 * it is the layer that reads the refusal and hands it down. */
const twoAccounts = (refusal: ProviderRefusal | undefined, seats: Record<string, SeatRefusal> = {}): Services =>
    services({
        claudeStore: {
            // No refresh token ⇒ ensureFreshToken answers with what is stored, so this test resolves a
            // credential without a network round trip.
            read: async (id: string) => ({ id, label: id, connectedAt: 0, accessToken: `token-${id}` }),
            list: async () => [
                { id: "refused", label: "refused", connectedAt: 0 },
                { id: "working", label: "working", connectedAt: 1 },
            ],
        },
        claudeSeats: { read: async () => seats, refuse: async () => {}, clear: async () => {} },
        // The refused account looks untouched precisely BECAUSE it is refused: nothing it was handed ever ran.
        accountUsage: {
            read: async () => ({
                refused: { measuredAt: 0, windows: [{ kind: "seven_day", utilization: 3, gates: "all" }] },
                working: { measuredAt: 0, windows: [{ kind: "seven_day", utilization: 74, gates: "all" }] },
            }),
            record: async () => {},
            clear: async () => {},
        },
        providerRefusals: {
            read: async () => (refusal === undefined ? {} : { claude: refusal }),
            record: async () => {},
            clear: async () => {},
            onChange: () => () => {},
        },
    });

const resolved = async (refusal: ProviderRefusal | undefined, account?: string, seats?: Record<string, SeatRefusal>) =>
    await resolveHarnessCredentials(twoAccounts(refusal, seats), { agent: "claude", ...(account !== undefined ? { account } : {}) });

test("an unnamed turn skips the account whose organization has refused it", async () => {
    const result = await resolved({ at: Date.now(), kind: "entitlement", message: "organization has disabled Claude Code", account: "refused" });
    expect(result.ok && result.credentials.account).toBe("working");
});

/* AND KEEPS SKIPPING IT once the refusal store has moved on, which is the case that costs real turns. That store
 * keeps ONE refusal per provider, so the next spent allowance on any Claude account overwrites the entitlement
 * one, and the seat is still off. The durable record is what benches the account; the refusal above is only the
 * hint that ranks it. */
test("a benched seat stays benched after the provider's last refusal is some other account's", async () => {
    const seats = { refused: { at: Date.now(), reason: "organization has disabled Claude Code" } };
    const result = await resolved({ at: Date.now(), kind: "limit", message: "usage limit reached", account: "working" }, undefined, seats);
    expect(result.ok && result.credentials.account).toBe("working");
});

// And with nothing left to fall back to, the benched account runs anyway: a turn that fails saying why beats
// "no Claude account connected", which would be a lie about a sandbox that has one.
test("a sandbox whose every seat is refused still resolves a credential", async () => {
    const seats = {
        refused: { at: Date.now(), reason: "organization has disabled Claude Code" },
        working: { at: Date.now(), reason: "organization has disabled Claude Code" },
    };
    const result = await resolved(undefined, undefined, seats);
    expect(result.ok && result.credentials.account).toBe("refused");
});

test("a spent allowance does not bench an account: the meters already describe that", async () => {
    // A `limit` refusal is the one kind a later reading CAN contradict, and the windows above already rank the
    // two accounts. Benching on it as well would retire an account for a window that has since reopened.
    const result = await resolved({ at: Date.now(), kind: "limit", message: "usage limit reached", account: "refused" });
    expect(result.ok && result.credentials.account).toBe("refused");
});

test("a named account is still the account that runs, refused or not", async () => {
    // The composer's own pick, which is a person choosing with the refusal on screen beside it: this gate is
    // for the callers that name nobody.
    const result = await resolved(
        { at: Date.now(), kind: "entitlement", message: "organization has disabled Claude Code", account: "refused" },
        "refused",
    );
    expect(result.ok && result.credentials.account).toBe("refused");
});
