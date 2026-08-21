import { afterEach, expect, test, vi } from "vitest";
import { e2eTier } from "./e2e.js";

afterEach(() => {
    vi.unstubAllEnvs();
});

test("no opt-in switch, no run: a plain `pnpm test` reaches none of these", () => {
    const tier = e2eTier("sandbox daemon", { enabledBy: "INTENTIC_E2E" });
    expect(tier.runs).toBe(false);
});

test("a switch left off says so, and is not read as non-empty", () => {
    // The distinction the seam is built on: `0` is an instruction to stay off, and a "does it carry something"
    // test would read it as an instruction to run.
    vi.stubEnv("INTENTIC_E2E", "0");
    expect(e2eTier("sandbox daemon", { enabledBy: "INTENTIC_E2E" }).runs).toBe(false);
    vi.stubEnv("INTENTIC_E2E", "1");
    expect(e2eTier("sandbox daemon", { enabledBy: "INTENTIC_E2E" }).runs).toBe(true);
});

test("asked for, and short of a credential: stands down rather than failing", () => {
    // The bug this seam was written for. The nightly sets one switch for every tier at once, so a tier it was
    // given no credentials for must skip: the previous spelling threw out of `beforeAll` and reddened CI.
    vi.stubEnv("INTENTIC_E2E", "1");
    const tier = e2eTier("intentic CLI end-to-end", { enabledBy: "INTENTIC_E2E", secrets: ["CLOUDFLARE_API_TOKEN"] });
    expect(tier.runs).toBe(false);
});

test("what is missing is in the title, which is where vitest prints it", () => {
    vi.stubEnv("INTENTIC_E2E", "1");
    vi.stubEnv("DISCORD_E2E_SENDER_TOKEN", "sender");
    const tier = e2eTier("discord + whisper", {
        enabledBy: "INTENTIC_E2E",
        secrets: ["DISCORD_E2E_BOT_TOKEN", "DISCORD_E2E_SENDER_TOKEN", "DISCORD_E2E_CHANNEL_ID"],
    });
    expect(tier.title).toBe("discord + whisper, stood down, no DISCORD_E2E_BOT_TOKEN + DISCORD_E2E_CHANNEL_ID");
});

test("with e2e not asked for at all, the title stays plain: every tier is off and saying so is noise", () => {
    const tier = e2eTier("discord + whisper", { enabledBy: "INTENTIC_E2E", secrets: ["DISCORD_E2E_BOT_TOKEN"] });
    expect(tier.title).toBe("discord + whisper");
});

test("a credential CI defined with no value counts as missing", () => {
    // CI hands an undefined-but-declared variable through as the empty string; taken as present it would
    // start the tier and fail against the real service with an empty token.
    vi.stubEnv("INTENTIC_E2E", "1");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    expect(e2eTier("intentic CLI end-to-end", { enabledBy: "INTENTIC_E2E", secrets: ["CLOUDFLARE_API_TOKEN"] }).runs).toBe(false);
});

test("everything named, and the tier runs and hands back its credentials", () => {
    vi.stubEnv("INTENTIC_E2E", "true");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-token");
    const tier = e2eTier("intentic CLI end-to-end", { enabledBy: "INTENTIC_E2E", secrets: ["CLOUDFLARE_API_TOKEN"] });
    expect(tier.runs).toBe(true);
    expect(tier.secrets.CLOUDFLARE_API_TOKEN).toBe("cf-token");
});

test("reaching for a credential where the tier does not run throws, naming it", () => {
    // Module scope executes even in a skipped file. A suite that lifts a token to a top-level `const` is back to
    // failing on absence, so the read itself has to say that is what happened.
    const tier = e2eTier("intentic CLI end-to-end", { enabledBy: "INTENTIC_E2E", secrets: ["CLOUDFLARE_API_TOKEN"] });
    expect(() => tier.secrets.CLOUDFLARE_API_TOKEN).toThrow(
        "intentic CLI end-to-end read CLOUDFLARE_API_TOKEN where the tier does not run: a secret may only be read inside the suite",
    );
});
