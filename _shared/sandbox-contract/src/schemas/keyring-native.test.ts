import { KEYRING_NAME_RE, KeyringCaptureOutcomeSchema, KeyringRefusalCodeSchema } from "./keyring.js";
import { KeyringNativeNameSchema, KeyringNativeOutcomeSchema, KeyringNativeRefusalCodeSchema } from "./keyring-native.js";

// keyring-native.ts spells three of keyring.ts's schemas again so the browser extension's bundle never reaches keyring.ts
// (and the zod namespace it imports); these hold the two spellings equal.

test("the extension's copies of keyring.ts's names, refusals and outcomes are the same", () => {
    expect(KeyringNativeRefusalCodeSchema.options).toEqual(KeyringRefusalCodeSchema.options);
    expect(KeyringNativeOutcomeSchema.options).toEqual(KeyringCaptureOutcomeSchema.options);
    for (const name of ["GITHUB_COM", "_1PASSWORD", "a", "1BAD", "has-dash", ""]) {
        expect(KeyringNativeNameSchema.safeParse(name).success).toBe(KEYRING_NAME_RE.test(name));
    }
});
