import { expect, test } from "vitest";
import { HOST_PRESETS, hostGrantSummary, localModelMemorySummary, matchHostPreset, walletPolicySummary } from "./previews";

/* The sentences the forms say back. Each is the actual thing being agreed to, so what it claims is pinned. */

test(`says the wallet policy the numbers add up to`, () => {
    expect(walletPolicySummary({ perPaymentMaxUsd: `1.00`, dailyCapUsd: `5.00`, autoApproveUnderUsd: `0` })).toBe(
        `Every payment asks you in chat first · at most $1.00 each · $5.00 a day.`,
    );
    expect(walletPolicySummary({ perPaymentMaxUsd: `2.50`, dailyCapUsd: `20`, autoApproveUnderUsd: `0.10` })).toBe(
        `Payments under $0.10 go through on their own, the rest ask you first · at most $2.50 each · $20 a day.`,
    );
    // A number that does not parse produces no sentence rather than a wrong one.
    expect(walletPolicySummary({ perPaymentMaxUsd: `a lot`, dailyCapUsd: `5`, autoApproveUnderUsd: `0` })).toBeUndefined();
});

test(`matches the switches back to the preset they spell`, () => {
    for (const preset of HOST_PRESETS) {
        expect(matchHostPreset(preset.grants)).toBe(preset.key);
    }
    // A hand-tuned mix is nobody's preset, and must not claim to be one.
    expect(matchHostPreset({ shell: `on`, write: `on`, screen: `off`, control: `off`, sandboxes: `off`, sandboxRemove: `off` })).toBeUndefined();
});

/* The grant, in one line and from the allowed half only: listing the blocked half too ran to three lines of a
 * form whose whole problem was length, and buried the part being decided. */
test(`states the grant in one line, from what is allowed`, () => {
    expect(hostGrantSummary({ shell: `on`, write: `off`, screen: `on`, control: `off`, sandboxes: `off`, sandboxRemove: `off` })).toBe(
        `May run commands and see the screen, and nothing else.`,
    );
    expect(hostGrantSummary({ shell: `on` })).toBe(`May run commands, and nothing else.`);
    expect(hostGrantSummary({})).toBe(`Read files only.`);
    // Everything granted has no "nothing else" to add.
    expect(hostGrantSummary({ shell: `on`, write: `on`, screen: `on`, control: `on`, sandboxes: `on`, sandboxRemove: `on` })).toBe(
        `May run commands, change files, see the screen, use the mouse and keyboard, manage its sandboxes and remove its sandboxes.`,
    );
});

test(`does the local model's RAM sum so the reader doesn't`, () => {
    expect(localModelMemorySummary({ model: `unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf`, context: `65536` })).toBe(
        `≈ 6 GB weights + 4 GB window: needs 10 GB of free RAM.`,
    );
    expect(localModelMemorySummary({ model: `unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf`, context: `custom`, contextTokens: `98304` })).toBe(
        `≈ 6 GB weights + 6 GB window: needs 12 GB of free RAM.`,
    );
    // A custom GGUF has no known weight: no figure beats a wrong one.
    expect(localModelMemorySummary({ model: `custom`, context: `65536` })).toBeUndefined();
});
