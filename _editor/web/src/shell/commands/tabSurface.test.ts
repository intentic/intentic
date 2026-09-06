// @vitest-environment jsdom
//
// The focus gate the shell-wide tab family rests on: one chord per verb (close, close all, cycle), registered
// by all three strips, resolved by which surface the keystroke came from. The second test is the convention
// itself, driven through the real registry: three commands on ONE chord, and boundCommand picking the one
// whose surface owns the focus.
import { afterEach, expect, it } from "vitest";
import { type TabSurface, tabSurfaceOf } from "./tabSurface";
import { boundCommand, registerCommand } from "./useCommands";
import type { Disposable } from "@intentic/extension-api";

// The shell in miniature: the terminal panel and the chat panel own a root class each, everything else (here
// the editor) is the fallback surface.
document.body.innerHTML = `
    <div class="term"><span class="tterm" data-id="pill"></span></div>
    <div class="chat-panel"><textarea data-id="composer"></textarea></div>
    <div class="editor"><span data-id="line"></span></div>
    <div class="chat-panel" data-id="nesting"><div class="term"><span data-id="nested-pill"></span></div></div>
`;

// A live keydown as the dispatcher sees one: dispatched for real, so `event.target` is the focused node rather
// than something hand-planted on the event.
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
    // Not in a panel at all, the editor, the shell's chrome, or focus parked on <body>: the workspace keeps
    // the family, which is where it acted before the other two joined.
    expect(tabSurfaceOf(keydownFrom(`line`))).toBe(`workspace`);
    expect(tabSurfaceOf(new KeyboardEvent(`keydown`))).toBe(`workspace`);
    // A prompt hosted inside another surface still belongs to the terminal: the innermost panel wins.
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
