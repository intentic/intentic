import { afterEach, describe, expect, it } from "vitest";
import { effectiveKeybinding, keymapOverrides, useKeymap } from "./useKeymap";

/* The keymap resolves a command's ACTIVE chord from three states: remapped (override wins), unbound (null override
 * = no shortcut), and default (no override falls through to the declared chord). The dispatcher and palette both
 * route through effectiveKeybinding, so these three cases are the whole contract that makes bindings rebindable. */

afterEach(() => {
    keymapOverrides.value = {};
});

describe(`effectiveKeybinding`, () => {
    it(`falls through to the declared default when there is no override`, () => {
        expect(effectiveKeybinding(`workspace.goToFile`, `Mod+P`)).toBe(`Mod+P`);
        expect(effectiveKeybinding(`view.agents`, undefined)).toBeUndefined();
    });

    it(`prefers a remap over the declared default`, () => {
        useKeymap().setKeybinding(`workspace.goToFile`, `Mod+E`);
        expect(effectiveKeybinding(`workspace.goToFile`, `Mod+P`)).toBe(`Mod+E`);
    });

    it(`treats a null override as unbound — the declared default is suppressed`, () => {
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
