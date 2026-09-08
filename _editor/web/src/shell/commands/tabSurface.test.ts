// @vitest-environment jsdom
// Pins the tab-surface focus gate: one chord per verb, registered by all three strips, resolved by which surface
// the keystroke came from.
import { afterEach, expect, it } from "vitest";
import { type TabSurface, tabSurfaceOf } from "./tabSurface";
import { boundCommand, registerCommand } from "./useCommands";
import type { Disposable } from "@intentic/extension-api";

// Terminal and chat panels get a root class each; everything else (the editor) is the fallback surface.
document.body.innerHTML = `
    <div class="term"><span data-term-tab data-id="pill"></span></div>
    <div class="chat-panel"><textarea data-id="composer"></textarea></div>
    <div class="editor"><span data-id="line"></span></div>
    <div class="chat-panel" data-id="nesting"><div class="term"><span data-id="nested-pill"></span></div></div>
`;

// Dispatches a real keydown so `event.target` is the focused node, not something hand-planted onto the event.
const keydownFrom = (id: string, init?: KeyboardEventInit): KeyboardEvent => {
    const element = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
    expect(element, `fixture node "${id}"`).not.toBeNull();
    let seen: KeyboardEvent | undefined;
    const listener = (event: Event): void => {
        seen = event as KeyboardEvent;
    };
    window.addEventListener(`keydown`, listener);
    element!.dispatchEvent(new KeyboardEvent(`keydown`, { bubbles: true, ...init }));
    window.removeEventListener(`keydown`, listener);
    return seen!;
};

let disposables: readonly Disposable[] = [];
afterEach(() => {
    for (const disposable of disposables) {
        disposable.dispose();
    }
    disposables = [];
});

it(`routes a keystroke to the strip it came from, and to the workspace when it came from neither`, () => {
    expect(tabSurfaceOf(keydownFrom(`pill`))).toBe(`terminal`);
    expect(tabSurfaceOf(keydownFrom(`composer`))).toBe(`chat`);
    expect(tabSurfaceOf(keydownFrom(`line`))).toBe(`workspace`);
    expect(tabSurfaceOf(new KeyboardEvent(`keydown`))).toBe(`workspace`);
    // Nested pill inside a chat panel still resolves to terminal: the innermost surface wins.
    expect(tabSurfaceOf(keydownFrom(`nested-pill`))).toBe(`terminal`);
});

it(`lets the three strips share one chord: the focused surface's command is the one that binds`, () => {
    const surfaces: readonly TabSurface[] = [`chat`, `terminal`, `workspace`];
    disposables = surfaces.map((surface) =>
        registerCommand({
            owner: `builtin`,
            command: `test.closeTab.${surface}`,
            title: `Close ${surface} tab`,
            keybinding: `Ctrl+Shift+X`,
            when: `tabSurface == '${surface}'`,
            handler: () => undefined,
        }),
    );

    const closeChord: KeyboardEventInit = { key: `X`, code: `KeyX`, ctrlKey: true, shiftKey: true };
    expect(boundCommand(keydownFrom(`composer`, closeChord), false)?.command).toBe(`test.closeTab.chat`);
    expect(boundCommand(keydownFrom(`pill`, closeChord), false)?.command).toBe(`test.closeTab.terminal`);
    expect(boundCommand(keydownFrom(`line`, closeChord), false)?.command).toBe(`test.closeTab.workspace`);
    // Registration order decides nothing here: the gates are mutually exclusive, so exactly one ever matches.
    expect(boundCommand(keydownFrom(`line`, { key: `X`, code: `KeyX`, ctrlKey: true }), false)).toBeUndefined();
});
