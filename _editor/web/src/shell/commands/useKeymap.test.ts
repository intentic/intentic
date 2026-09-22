import { describe, it, expect, afterEach } from "bun:test";
import { effectiveKeybinding, keymapOverrides, useKeymap } from "./useKeymap";

/* The keymap resolves a command's ACTIVE chord from three states: remapped (override wins), unbound (null override = no shortcut). */

afterEach(() => {
    keymapOverrides.value = {};
});

describe(`effectiveKeybinding`, () => {
    it(`falls through to the declared default when there is no override`, () => {
        expect(effectiveKeybinding(`workspace.goToAnything`, `Mod+P`)).toBe(`Mod+P`);
        expect(effectiveKeybinding(`view.agents`, undefined)).toBeUndefined();
    });

    it(`prefers a remap over the declared default`, () => {
        useKeymap().setKeybinding(`workspace.goToAnything`, `Mod+E`);
        expect(effectiveKeybinding(`workspace.goToAnything`, `Mod+P`)).toBe(`Mod+E`);
    });

    it(`treats a null override as unbound: the declared default is suppressed`, () => {
        useKeymap().unbindKeybinding(`terminal.toggle`);
        expect(effectiveKeybinding(`terminal.toggle`, `Ctrl+\``)).toBeUndefined();
    });

    it(`reverts to the declared default when the override is reset`, () => {
        const keymap = useKeymap();
        keymap.setKeybinding(`terminal.toggle`, `Mod+J`);
        keymap.resetKeybinding(`terminal.toggle`);
        expect(effectiveKeybinding(`terminal.toggle`, `Ctrl+\``)).toBe(`Ctrl+\``);
    });

    it(`resetKeymap clears every override at once`, () => {
        const keymap = useKeymap();
        keymap.setKeybinding(`a.one`, `Mod+1`);
        keymap.unbindKeybinding(`a.two`);
        keymap.resetKeymap();
        expect(keymapOverrides.value).toEqual({});
        expect(effectiveKeybinding(`a.one`, `Mod+P`)).toBe(`Mod+P`);
    });
});
