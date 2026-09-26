import {
    MINTED_PROVIDERS,
    mintedVariant,
    mintedVariants,
    PROVIDER_ACCESS,
    PROVIDER_VENDOR,
    type ProviderRefusal,
    TRIAL_ENDPOINT_ID,
    TRIAL_MODEL_ID,
} from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { SeatRefusal } from "../../runtimes/claude/claude-seats.js";
import { services, withTranslator } from "../../harness/route-services.testing.js";
import { testConfig } from "../../testing.js";
import { memoryCapabilitiesStore } from "../../capabilities/capabilities-slice.testing.js";
import type { HarnessCredential } from "./agent-request.js";
import { harnessCredentialOf, harnessEnv, resolveHarnessCredentials } from "./harness-credentials.js";

// A routed turn's translator serves exactly one model; every other name the harness might resolve (a subagent tier,
// Task's default) must collapse onto it or come back 502.

test("a routed endpoint collapses every model tier onto the endpoint's own model", () => {
    const env = harnessEnv({ kind: "routed", baseUrl: "http://127.0.0.1:8788", authToken: "local" }, { model: "gpt-5.6-sol" });
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
    const env = harnessEnv({ kind: "claude-oauth", token: "sk-oauth" }, { model: "claude-opus-5" });
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-oauth");
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBeUndefined();
    expect(env["ANTHROPIC_DEFAULT_OPUS_MODEL"]).toBeUndefined();
    expect(env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBeUndefined();
});

test("every harness TURN is told to ride out a provider outage rather than give up on it", () => {
    // Retry budget is about the provider being down, unrelated to which credential is in play; giving up here means
    // turn-resume.ts rebuilds from scratch at full context cost.
    const credentials: HarnessCredential[] = [
        { kind: "claude-oauth", token: "sk-oauth" },
        { kind: "routed", baseUrl: "http://127.0.0.1:8788", authToken: "local" },
        { kind: "container" },
    ];
    for (const credential of credentials) {
        expect(harnessEnv(credential)["CLAUDE_CODE_RETRY_WATCHDOG"]).toBe("1");
    }
});

test("a free-trial turn uses the platform's bounded key walk instead of the long harness watchdog", () => {
    const env = harnessEnv({ kind: "trial", baseUrl: "http://127.0.0.1:8788", authToken: "local" }, { model: "gemini-flash-latest" });
    expect(env["CLAUDE_CODE_RETRY_WATCHDOG"]).toBeUndefined();
    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:8788");
});

test("a free-trial turn resolves from constants: the synthetic model id, no catalog fetch, bounded policy", async () => {
    // `endpointModels` deliberately unstubbed: the trial's model is a known constant, so reaching for a catalog here
    // would throw, which is the regression this pins.
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
    // Boot fires the availability probe without awaiting it, so a turn can arrive first; the resolver must then ask the
    // platform itself rather than trust a stale "unavailable".
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
    // The regression this pins: a one-shot inheriting the turn's watchdog ground through a refusing rung instead of
    // failing over to the next model in the chain.
    const credentials: HarnessCredential[] = [
        { kind: "claude-oauth", token: "sk-oauth" },
        { kind: "routed", baseUrl: "http://127.0.0.1:8788", authToken: "local" },
        { kind: "container" },
    ];
    for (const credential of credentials) {
        expect(harnessEnv(credential, { helper: true })["CLAUDE_CODE_RETRY_WATCHDOG"]).toBeUndefined();
    }
    // Everything else about a helper's environment is a turn's: only the patience differs.
    expect(harnessEnv({ kind: "claude-oauth", token: "sk-oauth" }, { helper: true })["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-oauth");
    expect(harnessEnv({ kind: "container" }, { helper: true })["IS_SANDBOX"]).toBe("1");
});

test("a custom endpoint with no resolved model pins nothing rather than an empty id", () => {
    const env = harnessEnv({ kind: "routed", baseUrl: "https://router.example", authToken: "local" });
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://router.example");
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBeUndefined();
    expect(env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBeUndefined();
});

// Which account an unnamed turn lands on (a conversation's first turn on a provider, a one-off, an automation naming
// none), picked by headroom — which an entitlement refusal alone can defeat: an untouched, refused account has the
// best-looking meter and would win forever without this. Every later turn of a conversation arrives here already
// naming its account (routingFor), and is moved off a refused one before this (providers/accounts/blocked-account.ts).
const twoAccounts = (refusal: ProviderRefusal | undefined, seats: Record<string, SeatRefusal> = {}): Services =>
    services({
        claudeStore: {
            // No refresh token ⇒ ensureFreshToken returns what's stored, so this resolves without a network round trip.
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
            markUnread: async () => undefined,
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

// The refusal store keeps only one refusal per provider, so a later spent-allowance refusal on any account overwrites
// the entitlement one — but the durable seat record, not that hint, is what actually benches an account.
test("a benched seat stays benched after the provider's last refusal is some other account's", async () => {
    const seats = { refused: { at: Date.now(), reason: "organization has disabled Claude Code" } };
    const result = await resolved({ at: Date.now(), kind: "limit", message: "usage limit reached", account: "working" }, undefined, seats);
    expect(result.ok && result.credentials.account).toBe("working");
});

// With nothing left to fall back to, the benched account runs anyway: a turn that fails saying why beats falsely
// claiming no account is connected.
test("a sandbox whose every seat is refused still resolves a credential", async () => {
    const seats = {
        refused: { at: Date.now(), reason: "organization has disabled Claude Code" },
        working: { at: Date.now(), reason: "organization has disabled Claude Code" },
    };
    const result = await resolved(undefined, undefined, seats);
    expect(result.ok && result.credentials.account).toBe("refused");
});

test("a spent allowance reads its account as spent until a reading with room lands after it", async () => {
    // A polled reading freezes the moment a pool empties, so the refusal is the fresher fact; a later reading with room
    // contradicts it, which is how a window that has since reopened gets its account back.
    const standing = await resolved({ at: Date.now(), kind: "limit", message: "usage limit reached", account: "refused" });
    expect(standing.ok && standing.credentials.account).toBe("working");
    const answered = await resolved({ at: -1, kind: "limit", message: "usage limit reached", account: "refused" });
    expect(answered.ok && answered.credentials.account).toBe("refused");
});

test("a named account is the account that runs, refused or not", async () => {
    // Routing is decided before a credential is minted: a conversation's remembered account is moved off a refused one
    // where the turn is planned (blocked-account.ts), so the account named here is either one a person or an
    // automation chose for this turn, which runs and lets its refusal say why, or the ready one the turn was moved to.
    const result = await resolved(
        { at: Date.now(), kind: "entitlement", message: "organization has disabled Claude Code", account: "refused" },
        "refused",
    );
    expect(result.ok && result.credentials.account).toBe("refused");
});

// The account a conversation runs on is the one it names. A container that authenticates by itself holds some other
// identity, so falling to it when the named account is gone would move the conversation onto an account nobody chose.
describe("a turn naming a Claude account that can no longer serve it", () => {
    const withContainerToken = (): Services =>
        services({
            config: { ...testConfig, claudeCodeOauthToken: "container-token" },
            claudeStore: {
                read: async (id: string) => (id === "other" ? { id, label: id, connectedAt: 0, accessToken: "token-other" } : undefined),
                list: async () => [{ id: "other", label: "other", connectedAt: 0 }],
            },
        });

    test("refuses, even where the container has a credential of its own", async () => {
        expect(await resolveHarnessCredentials(withContainerToken(), { agent: "claude", account: "gone" })).toEqual({
            ok: false,
            message: "The Claude account this conversation runs on is no longer connected. Pick another account for it, or connect this one again, then send again.",
        });
    });

    test("an unnamed turn still lands on a connected account", async () => {
        const result = await resolveHarnessCredentials(withContainerToken(), { agent: "claude" });
        expect(result.ok && result.credentials.account).toBe("other");
    });
});

// The assertion the spec-table conformance tests can't make: a wrong entitlement or a doubled version segment in a base
// URL is type-correct and passes every table walk without ever reaching a model.
describe.each(MINTED_PROVIDERS.map((provider) => ({ provider })))("a $provider turn", ({ provider }) => {
    // The estate a choice-less sign-in would use: what a single-estate provider always mints.
    const defaultVariant = mintedVariant(provider)!;
    const withKey = async (variant: string = defaultVariant.id) => {
        const sandbox = services({});
        await sandbox.minted[provider].store.connect({ apiKey: "vendor-key", variant });
        return sandbox;
    };

    test("points the harness at the estate's own Anthropic endpoint with the minted key", async () => {
        const result = await resolveHarnessCredentials(await withKey(), { agent: provider });
        expect(result.ok).toBe(true);
        const endpoint = result.ok ? result.credentials.endpoint : undefined;
        expect(endpoint?.baseUrl).toBe(defaultVariant.anthropicBase);
        expect(endpoint?.authToken).toBe("vendor-key");
        // The harness appends `/v1/messages` itself; a base URL that already has one 404s mid-conversation.
        expect(endpoint?.baseUrl).not.toMatch(/\/v\d+$/);
        // Vendor is named so a 429 here doesn't report as Claude's; no `limit`, since neither vendor publishes a quota
        // surface a stored key can read.
        expect(result.ok && result.credentials.allowance?.vendor).toBe(PROVIDER_VENDOR[provider]);
        expect(result.ok && result.credentials.allowance?.limit).toBeUndefined();
    });

    // Another connected account would take the conversation somewhere nobody chose; which one is the person's call.
    test("refuses a named account that is no longer connected, rather than running on the first one", async () => {
        expect(await resolveHarnessCredentials(await withKey(), { agent: provider, account: "disconnected" })).toEqual({
            ok: false,
            message: expect.stringContaining("account this conversation runs on is no longer connected"),
        });
    });

    test("carries no Claude subscription token into the vendor's environment", async () => {
        const result = await resolveHarnessCredentials(await withKey(), { agent: provider });
        const env = harnessEnv(result.ok ? harnessCredentialOf(result.credentials) : { kind: "container" }, {
            model: result.ok ? result.credentials.endpoint?.model : undefined,
        });
        expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("vendor-key");
        expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    });

    test("resolves a model the catalog actually offers, whatever the picker held", async () => {
        const sandbox = await withKey();
        const catalog = await sandbox.minted[provider].catalogOf(defaultVariant.id).models();
        const result = await resolveHarnessCredentials(sandbox, { agent: provider, model: "a-model-the-vendor-retired" });
        // A pick the catalog no longer offers falls to its default rather than being sent and refused.
        expect(result.ok && result.credentials.endpoint?.model).toBe(catalog.default);
    });

    // One case per estate the provider sells through: Z.ai's two hosts exist because a mainland key sent to api.z.ai
    // reads as a bad credential, not as the wrong host.
    test.each((mintedVariants(provider) ?? []).map((variant) => ({ variant })))("on $variant.id dials that estate's host", async ({ variant }) => {
        const result = await resolveHarnessCredentials(await withKey(variant.id), { agent: provider });
        expect(result.ok && result.credentials.endpoint?.baseUrl).toBe(variant.anthropicBase);
    });

    // Refused rather than silently defaulted to another host: that would spend the turn on an auth error about a
    // perfectly good key, pointing the user at their credential instead of their connection.
    test("an account from an estate this sandbox no longer offers is refused rather than defaulted", async () => {
        const result = await resolveHarnessCredentials(await withKey("an-estate-that-was-retired"), { agent: provider });
        expect(result.ok).toBe(false);
        expect(!result.ok && result.code).toBe("subscription-required");
        expect(!result.ok && result.message).toContain("Connect it again");
    });

    test("with no key connected, refuses by naming what to connect rather than falling through to Claude", async () => {
        const result = await resolveHarnessCredentials(services({}), { agent: provider });
        expect(result.ok).toBe(false);
        expect(!result.ok && result.code).toBe("subscription-required");
        expect(!result.ok && result.message).toContain(PROVIDER_ACCESS[provider].requirement);
    });
});
