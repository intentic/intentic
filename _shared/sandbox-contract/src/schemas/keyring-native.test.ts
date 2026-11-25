import { KeyringCaptureOutcomeSchema, KeyringRefusalCodeSchema, KeyringSecretNameSchema } from "./keyring.js";
import { KeyringNativeNameSchema, KeyringNativeOutcomeSchema, KeyringNativeRefusalCodeSchema } from "./keyring-native.js";

// keyring-native.ts spells three of keyring.ts's schemas again so the browser extension's bundle never reaches keyring.ts
// (and the zod namespace it imports); these hold the two spellings equal.

test("the extension's copies of keyring.ts's names, refusals and outcomes are the same", () => {
    expect(KeyringNativeRefusalCodeSchema.options).toEqual(KeyringRefusalCodeSchema.options);
    expect(KeyringNativeOutcomeSchema.options).toEqual(KeyringCaptureOutcomeSchema.options);
    for (const name of ["GITHUB_COM", "_1PASSWORD", "a", "1BAD", "has-dash", "", "__proto__", "constructor", "prototype"]) {
        expect(KeyringNativeNameSchema.safeParse(name).success).toBe(KeyringSecretNameSchema.safeParse(name).success);
    }
});

test("a secret's name is never one Object.prototype already has, since it keys the vault's plain objects", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "prototype"]) {
        expect(KeyringSecretNameSchema.safeParse(name).success).toBe(false);
    }
    expect(KeyringSecretNameSchema.safeParse("CONSTRUCTOR").success).toBe(true);
    expect(KeyringSecretNameSchema.safeParse("_proto").success).toBe(true);
});
