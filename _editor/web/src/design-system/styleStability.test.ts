// @vitest-environment jsdom
import { stabilizeStyleWrites } from "@intentic/ui/style-stability";
import { afterEach, expect, it } from "vitest";

/* Hot CSS updates replace the style node's text in place. */
const updateStyle = (id: string, content: string): void => {
    const existing = document.head.querySelector<HTMLStyleElement>(`style[data-vite-dev-id="${id}"]`);
    if (existing === null) {
        const style = document.createElement(`style`);
        style.setAttribute(`data-vite-dev-id`, id);
        style.textContent = content;
        document.head.append(style);
        return;
    }
    existing.textContent = content;
};

const textNodeChanges = (style: HTMLStyleElement, act: () => void): MutationRecord[] => {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));
    observer.observe(style, { childList: true, characterData: true, subtree: true });
    act();
    observer.takeRecords().forEach((record) => seen.push(record));
    observer.disconnect();
    return seen;
};

const settle = async (): Promise<void> => {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
};

afterEach(() => {
    document.head.innerHTML = ``;
});

it(`drops a hot CSS update that carries the bytes the page already has`, async () => {
    updateStyle(`/src/styles.css`, `:root { --color-primary: #ff8800 }`);
    stabilizeStyleWrites(`style[data-vite-dev-id]`);
    await settle();
    const style = document.head.querySelector<HTMLStyleElement>(`style[data-vite-dev-id]`)!;

    const changes = textNodeChanges(style, () => updateStyle(`/src/styles.css`, `:root { --color-primary: #ff8800 }`));

    expect(changes).toEqual([]);
    expect(style.textContent).toBe(`:root { --color-primary: #ff8800 }`);
});

it(`applies a hot CSS update that actually changed`, async () => {
    updateStyle(`/src/styles.css`, `:root { --color-primary: #ff8800 }`);
    stabilizeStyleWrites(`style[data-vite-dev-id]`);
    await settle();
    const style = document.head.querySelector<HTMLStyleElement>(`style[data-vite-dev-id]`)!;

    const changes = textNodeChanges(style, () => updateStyle(`/src/styles.css`, `:root { --color-primary: #00ccff }`));

    expect(changes).not.toEqual([]);
    expect(style.textContent).toBe(`:root { --color-primary: #00ccff }`);
});

it(`covers a stylesheet a lazy view appends after the guard is installed`, async () => {
    stabilizeStyleWrites(`style[data-vite-dev-id]`);
    await settle();
    updateStyle(`/src/pages/Late.vue?vue&type=style`, `.late { color: red }`);
    await settle();
    const style = document.head.querySelector<HTMLStyleElement>(`style[data-vite-dev-id$="type=style"]`)!;

    const changes = textNodeChanges(style, () => updateStyle(`/src/pages/Late.vue?vue&type=style`, `.late { color: red }`));

    expect(changes).toEqual([]);
});

it(`leaves style nodes outside the selector alone`, async () => {
    stabilizeStyleWrites(`style[data-vite-dev-id]`);
    await settle();
    const foreign = document.createElement(`style`);
    foreign.textContent = `.foreign { color: red }`;
    document.head.append(foreign);
    await settle();

    const changes = textNodeChanges(foreign, () => {
        foreign.textContent = `.foreign { color: red }`;
    });

    // The guard is scoped: an unclaimed node keeps the browser's own behaviour, replacing its text node even
    // for identical text. Nothing here asks for that; it is what makes the claim above meaningful.
    expect(changes).not.toEqual([]);
});
