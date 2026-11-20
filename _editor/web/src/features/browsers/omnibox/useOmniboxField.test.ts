import type { BrowsingEntry, BrowsingForgetInput } from "@intentic/sandbox-contract/schemas/browsing";
import { unstubbed } from "@intentic/testing";
import { nextTick, ref } from "vue";
import { inSetup, provided } from "../../../testing/inSetup";
import { NO_MARKS } from "../bookmarks/bookmarkTree";
import { BROWSING_SOURCE, type BrowsingSource } from "./browsingSource";
import type { TabCandidate } from "./rank";
import { stepHighlight, useOmniboxField } from "./useOmniboxField";

// The address bar's keys over a real field: what it shows, what it selects, and what Enter sends.

const NOW = 1_790_000_000_000;
const page = (url: string, frecency: number, title?: string): BrowsingEntry => {
    const entry: BrowsingEntry = { url, visits: 1, typed: 1, last: NOW, frecency };
    return title === undefined ? entry : { ...entry, title };
};

const HISTORY = [page(`http://192.168.0.168/`, 600, `FRITZ!Box`), page(`https://github.com/`, 900, `GitHub`), page(`https://github.com/intentic`, 300, `intentic`)];

let profiles = 0;

const mountField = (value = `https://example.com/`, tabs: readonly TabCandidate[] = []) => {
    const said: string[] = [];
    const forgotten: BrowsingForgetInput[] = [];
    const source = unstubbed<BrowsingSource>(`source`, {
        history: async (profile) => ({ profile, cursor: `c.1`, full: true, entries: HISTORY, removed: [], terms: [], profiles: [profile] }),
        forget: async (input) => {
            forgotten.push(input);
            return 1;
        },
        suggest: async (q) => ({ q, suggestions: [] }),
    });
    const input = document.createElement(`input`);
    document.body.append(input);
    profiles += 1;
    const { result, stop } = inSetup(
        () =>
            useOmniboxField({
                value: ref(value),
                editable: ref(true),
                // A profile of its own per field: the held history is shared by profile across a sandbox.
                profile: ref(`_field-${profiles}`),
                engine: ref(`brave` as const),
                tabs: ref(tabs),
                marks: ref(NO_MARKS),
                input: ref(input),
                submit: (url) => said.push(`submit ${url}`),
                switchTab: (tab) => said.push(`switch ${tab.session}/${tab.pageId}`),
                cancel: () => said.push(`cancel`),
            }),
        { provides: [provided(BROWSING_SOURCE, source)] },
    );
    const settle = async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await nextTick();
    };
    const type = (text: string, inputType = `insertText`): void => {
        input.value = text;
        input.setSelectionRange(text.length, text.length);
        result.onInput(new InputEvent(`input`, { inputType }));
    };
    const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
        const event = new KeyboardEvent(`keydown`, { key, cancelable: true, ...init });
        result.onKeydown(event);
        return event;
    };
    const focus = async (): Promise<void> => {
        result.onFocus();
        await settle();
    };
    const unmount = (): void => {
        stop();
        input.remove();
    };
    return { field: result, input, said, forgotten, type, press, focus, settle, stop: unmount };
};

test("typing a host's first digits completes it inline with the rest selected, and Enter goes there", async () => {
    const box = mountField();
    await box.focus();
    box.type(`19`);
    expect(box.input.value).toBe(`192.168.0.168`);
    expect([box.input.selectionStart, box.input.selectionEnd]).toEqual([2, 13]);
    expect(box.field.open.value).toBe(true);
    box.press(`Enter`);
    expect(box.said).toEqual([`submit http://192.168.0.168/`]);
    box.stop();
});

test("typing on over a completion completes again, the rest still selected", async () => {
    const box = mountField();
    await box.focus();
    box.type(`1`);
    expect(box.input.value).toBe(`192.168.0.168`);
    // The "9" replaces the selected rest, as a field does: the completion is the same, the field's text is not.
    box.type(`19`);
    expect(box.input.value).toBe(`192.168.0.168`);
    expect([box.input.selectionStart, box.input.selectionEnd]).toEqual([2, 13]);
    box.stop();
});

test("text typed over the whole field completes from itself, not from what it replaced", async () => {
    const box = mountField();
    await box.focus();
    box.type(`192`);
    box.type(`192`, `deleteContentBackward`);
    // Select all, then "g": the field holds only the "g".
    box.type(`g`);
    expect(box.input.value).toBe(`github.com`);
    expect([box.input.selectionStart, box.input.selectionEnd]).toEqual([1, 10]);
    box.stop();
});

test("a deletion takes the completion away without completing again", async () => {
    const box = mountField();
    await box.focus();
    box.type(`gi`);
    expect(box.input.value).toBe(`github.com`);
    box.type(`gi`, `deleteContentBackward`);
    expect(box.input.value).toBe(`gi`);
    box.press(`Enter`);
    expect(box.said).toEqual([`submit https://search.brave.com/search?q=gi`]);
    box.stop();
});

test("Tab keeps the completion as typed; ↓ walks the rows, showing each; Escape steps back, then gives up", async () => {
    const box = mountField();
    await box.focus();
    box.type(`gi`);
    expect(box.press(`Tab`).defaultPrevented).toBe(true);
    expect(box.input.value).toBe(`github.com`);
    box.press(`ArrowDown`);
    expect(box.field.highlight.value).toBe(1);
    expect(box.input.value).toBe(`github.com/intentic`);
    box.press(`Escape`);
    expect(box.field.open.value).toBe(false);
    expect(box.input.value).toBe(`github.com`);
    box.press(`Escape`);
    expect(box.said).toEqual([`cancel`]);
    box.stop();
});

test("Ctrl+Enter makes a bare word a .com site", async () => {
    const box = mountField();
    await box.focus();
    box.type(`intentic`);
    box.press(`Enter`, { ctrlKey: true });
    expect(box.said).toEqual([`submit https://www.intentic.com`]);
    box.stop();
});

test("Shift+Delete forgets the highlighted page from history", async () => {
    const box = mountField();
    await box.focus();
    box.type(`github.com/`);
    box.press(`ArrowDown`);
    const row = box.field.rows.value[box.field.highlight.value];
    expect(row?.kind === `history` ? row.url : undefined).toBe(`https://github.com/intentic`);
    expect(box.press(`Delete`, { shiftKey: true }).defaultPrevented).toBe(true);
    await box.settle();
    expect(box.forgotten).toEqual([{ profile: expect.stringMatching(/^_field-/), forget: { kind: `urls`, urls: [`https://github.com/intentic`] } }]);
    box.stop();
});

test("an open tab is switched to rather than opened again", async () => {
    const box = mountField(`https://example.com/`, [{ session: `browser-own`, pageId: `p3`, url: `https://vuejs.org/`, title: `Vue.js` }]);
    await box.focus();
    box.type(`vue`, `deleteContentBackward`);
    const at = box.field.rows.value.findIndex((row) => row.kind === `tab`);
    expect(at).toBe(1);
    const row = box.field.rows.value[at];
    if (row !== undefined) {
        box.field.choose(row);
    }
    expect(box.said).toEqual([`switch browser-own/p3`]);
    box.stop();
});

test("a blank page's empty field offers the pages most worth going back to as it takes focus", async () => {
    const box = mountField(``);
    await box.focus();
    expect(box.field.open.value).toBe(true);
    expect(box.field.rows.value.map((row) => (row.kind === `history` ? row.url : row.kind))).toEqual([
        `https://github.com/`,
        `http://192.168.0.168/`,
        `https://github.com/intentic`,
    ]);
    box.stop();
});

test("the arrows wrap at both ends", () => {
    expect(stepHighlight(2, 1, 3)).toBe(0);
    expect(stepHighlight(0, -1, 3)).toBe(2);
    expect(stepHighlight(0, 1, 0)).toBe(0);
});
