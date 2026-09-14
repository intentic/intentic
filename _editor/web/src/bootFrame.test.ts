// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// index.html has to be able to draw one frame on its own, because everything else about this app is downstream of a
// bundle that has not arrived yet. On a cold start — a new machine, an empty HTTP cache, a webview profile being
// created underneath it — the gap between "the document painted" and "Vue mounted" is the entire window, and an
// empty container for that long is what the desktop app's first launch looked like: a black rectangle.

const html = readFileSync(resolve(import.meta.dirname, `../index.html`), `utf8`);
const main = readFileSync(resolve(import.meta.dirname, `./main.ts`), `utf8`);
const page = new DOMParser().parseFromString(html, `text/html`);

/** What main.ts hands to Vue. Read from the source, since the mount is what clears whatever is inside it. */
const mountSelector = (): string => {
    const selector = /\.mount\(\s*["'`]([^"'`]+)["'`]\s*\)/u.exec(main)?.[1];
    expect(selector, `main.ts mounts on nothing this test can find`).toEqual(expect.any(String));
    return selector ?? ``;
};

describe(`the boot frame`, () => {
    // Inside the mount is the whole disposal plan: `app.mount` empties its container, so there is no teardown to
    // forget and no frame where the mark and the app are both on screen.
    it(`stands inside the element Vue mounts on, and names what is happening`, () => {
        const root = page.querySelector(mountSelector());

        expect(root?.querySelector(`.boot .boot-mark`)).not.toBeNull();
        expect(root?.querySelector(`.boot .boot-note`)?.textContent?.trim()).not.toBe(``);
    });

    it(`carries its own styles, since the stylesheet it stands in for may not have arrived`, () => {
        const inline = [...page.querySelectorAll(`head style`)].map((style) => style.textContent ?? ``).join(``);

        expect(inline).toContain(`.boot`);
        expect(inline).toContain(`.boot-mark`);
    });

    // A start that is merely slow must never be called broken, so the second line ships hidden and arrives late; a
    // start that is stuck leaves the reader something to press. `isConnected` is the mount's cancellation: by the
    // time the timer runs, a successful boot has already detached the element it asks about.
    it(`holds back the stuck-start notice until a timer that a mount cancels`, () => {
        const slow = page.querySelector(`.boot-slow`);

        expect(slow?.hasAttribute(`hidden`)).toBe(true);
        expect(slow?.querySelector(`#boot-reload`)).not.toBeNull();
        expect(html).toContain(`isConnected`);
    });
});
