import { manifest } from "./manifest.js";
import { AUTO_START, autoStartOf, ENGINE, engineOf } from "./settings.js";

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

describe(`the engine setting`, () => {
    it(`is declared as a choice of the two engines, the browser one by default`, () => {
        const declared = manifest.contributes?.settings?.find((setting) => setting.key === ENGINE);
        expect(declared).toMatchObject({ type: `enum`, enum: [`browser`, `server`], default: `browser` });
    });

    it(`reads the document server only when it is named, and the browser engine for anything else`, () => {
        expect(engineOf({ [ENGINE]: `server` })).toBe(`server`);
        expect(engineOf({ [ENGINE]: `browser` })).toBe(`browser`);
        expect(engineOf({ [ENGINE]: `docker` })).toBe(`browser`);
        expect(engineOf({})).toBe(`browser`);
        expect(engineOf(undefined)).toBe(`browser`);
    });
});
