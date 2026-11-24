import { HUB_ACCOUNT_PROVIDERS } from "../../schemas/connection-hub.js";
import { NATIVE_PROVIDERS, providerSpec } from "../provider-specs.js";
import { HUB_PROVIDERS, isModelPlaced, PROVIDER_TRAITS, providerHas, providersWhere, providerTraits } from "./provider-traits.js";

// Sorted, so a pin reads as a list and order never decides a match.
const sorted = (providers: Iterable<string>): string[] => [...providers].toSorted();
const where = (pick: Parameters<typeof providersWhere>[0]): string[] => sorted(providersWhere(pick));
const byProvider = <T,>(read: (provider: (typeof NATIVE_PROVIDERS)[number]) => T): Record<string, T> =>
    Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, read(provider)]));

test("the table has one row per native provider", () => {
    expect(sorted(Object.keys(PROVIDER_TRAITS))).toEqual(sorted(NATIVE_PROVIDERS));
});

// Each pin is the hand-kept list or `provider === "x"` branch the trait replaced, as it stood on 2026-11-23: a change here is
// a behaviour change.
test("every derived set matches the list or branch it replaced", () => {
    expect(HUB_ACCOUNT_PROVIDERS).toEqual(["cursor", "devin", "zai", "meta"]);
    expect(HUB_PROVIDERS).toEqual(HUB_ACCOUNT_PROVIDERS);
    expect(where((t) => t.firstPartyAnthropic)).toEqual(["claude"]);
    expect(where((t) => t.effortScale === "anthropic")).toEqual(["claude"]);
    expect(where((t) => t.thinkingToggle)).toEqual(["claude"]);
    expect(where((t) => t.seatProbe)).toEqual(["claude"]);
    expect(where((t) => t.placesByModel)).toEqual(sorted(["claude", "cursor"]));
    expect(where((t) => t.childPlacement === "per-account")).toEqual(["claude"]);
    expect(where((t) => t.needsProject)).toEqual(["gemini"]);
    expect(where((t) => t.refusesClaudeCodeMentions)).toEqual(["gemini"]);
    expect(where((t) => t.opencodeWire === "openai-responses")).toEqual(["codex"]);
    expect(where((t) => t.pasteBack === "token")).toEqual(["devin"]);
    expect(where((t) => t.signInCodePrefilled)).toEqual(["grok"]);
    expect(Object.fromEntries(providersWhere((t) => t.ownSignInLoop !== undefined).map((p) => [p, providerTraits(p)?.ownSignInLoop]))).toEqual({
        grok: "opencode",
    });
    expect(Object.fromEntries(providersWhere((t) => t.translatorSignIn !== undefined).map((p) => [p, providerTraits(p)?.translatorSignIn]))).toEqual({
        codex: "device-or-loopback",
        grok: "device",
        kimi: "device",
        gemini: "redirect",
    });
});

test("the compliance report's provider hosts are today's", () => {
    expect(byProvider((provider) => providerTraits(provider)?.destination)).toEqual({
        claude: { hosts: ["api.anthropic.com"], operator: "Anthropic PBC", region: "US", thirdCountry: true },
        codex: { hosts: ["chatgpt.com", "api.openai.com"], operator: "OpenAI", region: "US", thirdCountry: true },
        grok: { hosts: ["api.x.ai"], operator: "xAI", region: "US", thirdCountry: true },
        kimi: { hosts: ["api.kimi.com"], operator: "Moonshot AI", region: "CN", thirdCountry: true },
        gemini: undefined,
        cursor: undefined,
        devin: undefined,
        meta: { hosts: ["api.meta.ai"], operator: "Meta Platforms", region: "US", thirdCountry: true },
        zai: { hosts: ["api.z.ai"], operator: "Z.ai", thirdCountry: true },
    });
});

test("translator-only traits sit on translator providers alone", () => {
    for (const provider of NATIVE_PROVIDERS) {
        const translator = providerSpec(provider)?.auth.kind === "translator";
        expect({ provider, signIn: providerTraits(provider)?.translatorSignIn !== undefined }).toEqual({ provider, signIn: translator });
        if (providerTraits(provider)?.ownSignInLoop !== undefined) {
            expect(translator).toBe(true);
        }
    }
});

test("a string no native provider answers to has no traits", () => {
    expect(providerTraits("endpoint/acme")).toBeUndefined();
    expect(providerHas("endpoint/acme", "firstPartyAnthropic")).toBe(false);
    expect(isModelPlaced("cursor")).toBe(true);
    expect(isModelPlaced("devin")).toBe(false);
});
