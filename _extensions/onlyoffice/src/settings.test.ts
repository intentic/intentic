import { describe, it, expect } from "bun:test";
import { manifest } from "./manifest.js";
import { AUTO_START, autoStartOf } from "./settings.js";

describe(`the auto-start setting`, () => {
    it(`is declared as a boolean that defaults to off, and the backend may read it`, () => {
        const declared = manifest.contributes?.settings?.find((setting) => setting.key === AUTO_START);
        expect(declared).toMatchObject({ type: `boolean`, default: false });
        expect(manifest.permissions?.daemon).toContain(`GET /extensions/*/settings`);
    });

    it(`reads only a true boolean as on`, () => {
        expect(autoStartOf({ [AUTO_START]: true })).toBe(true);
        expect(autoStartOf({ [AUTO_START]: false })).toBe(false);
        expect(autoStartOf({ [AUTO_START]: `true` })).toBe(false);
        expect(autoStartOf({})).toBe(false);
        expect(autoStartOf(undefined)).toBe(false);
    });
});
