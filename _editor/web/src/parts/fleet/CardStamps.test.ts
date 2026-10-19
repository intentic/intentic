import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
import CardStamps from "./CardStamps.vue";
import type { Stamp } from "../../models/fleet/board/stamps";

// THE STAMPS ARE BADGES AT REST AND WORDS ON DEMAND: one badge per check that ran, a mark beside it only when it needs
// the reader, and a card that says each in full under a pointer that stays. A mark, never a press.

let app: App | undefined;

const mount = async (props: { stamps: readonly Stamp[]; quiet?: boolean; max?: number }): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(CardStamps, props) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await nextTick();
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

const SELF: Stamp = { kind: `self`, outcome: `passed`, stale: false, check: `pnpm -C api test`, unviewed: 2 };
const REVIEW: Stamp = { kind: `review`, outcome: `findings`, findings: 3, open: 1, stale: false, by: `reviewer`, own: false };
const TEST: Stamp = { kind: `test`, outcome: `done`, stale: true, by: `tester`, own: false };

const stampsOf = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(`[data-stamps]`)!;
// Each badge drawn, by the kind whose symbol is cut out of it.
const badges = (el: HTMLElement): (string | null)[] =>
    [...el.querySelectorAll(`[data-stamp] [data-stamp-badge]`)].map((badge) => badge.getAttribute(`data-stamp-kind`));
const card = (): HTMLElement | null => document.querySelector<HTMLElement>(`[data-stamps-card]`);
// The overlay closes on an anchor with no size, which is every element in a DOM that lays nothing out.
const sized = (anchor: HTMLElement): HTMLElement => {
    anchor.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 100, width: 40, height: 14 });
    return anchor;
};

it(`draws nothing at all for work nothing checked`, async () => {
    expect(stampsOf(await mount({ stamps: [] }))).toBeNull();
});

it(`draws one badge per kind, and a mark only beside the stamp that needs you`, async () => {
    const el = await mount({ stamps: [SELF, REVIEW, TEST] });
    expect(badges(el)).toEqual([`self`, `review`, `test`]);
    // Every badge is the same seal, its kind's symbol cut out of it.
    expect(new Set([...el.querySelectorAll(`[data-stamp-badge] > path[mask]`)].map((seal) => seal.getAttribute(`d`))).size).toBe(1);
    expect([...el.querySelectorAll(`[data-stamp-mark]`)].map((mark) => mark.textContent)).toEqual([`1`]);
    const [self, review, test] = [...el.querySelectorAll<HTMLElement>(`[data-stamp]`)];
    expect([self?.className, review?.className, test?.className].map((name) => name?.match(/text-\w+/)?.[0])).toEqual([
        `text-success`,
        `text-warning`,
        `text-faint`,
    ]);
});

it(`names every stamp in its accessible name, as its card says them`, async () => {
    const el = await mount({ stamps: [SELF, REVIEW, TEST] });
    expect(stampsOf(el).getAttribute(`aria-label`)?.split(`\n`)).toEqual([
        `Checks on this work`,
        `Self-check: passed after its last edit`,
        `Code review: 1 of 3 findings open`,
        `Test: done, its report is in its chat · the work changed since`,
    ]);
});

// A click on the stamps is the card's, which opens the card: nothing here is a button.
it(`is a mark, never a press`, async () => {
    const el = await mount({ stamps: [SELF, REVIEW, TEST] });
    const stamps = stampsOf(el);
    expect([stamps.tagName, stamps.getAttribute(`role`), stamps.querySelector(`button`)]).toEqual([`SPAN`, `img`, null]);
    stamps.click();
    await nextTick();
    expect(card()).toBeNull();
});

it(`says each stamp in words on a card a staying pointer raises`, async () => {
    const el = await mount({ stamps: [SELF, REVIEW, TEST] });
    const stamps = sized(stampsOf(el));
    stamps.dispatchEvent(new PointerEvent(`pointerenter`, { pointerType: `mouse` }));
    // Nothing for a pointer passing through.
    expect(card()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 260));
    await nextTick();
    const words = card()?.textContent ?? ``;
    expect(words).toContain(`pnpm -C api test`);
    expect(words).toContain(`Changed 2 interface files without looking at the result`);
    expect(words).toContain(`In a fresh session`);
    expect(words).toContain(`the work changed since`);
    // A check that ran in a chat of its own opens that chat; the agent's own check ran in this card's.
    expect([...document.querySelectorAll(`[data-stamp-row]`)].map((row) => row.querySelector(`button`) !== null)).toEqual([false, true, true]);
    // The card names each stamp beside its own badge.
    expect([...document.querySelectorAll(`[data-stamp-row] [data-stamp-badge]`)].map((badge) => badge.getAttribute(`data-stamp-kind`))).toEqual([
        `self`,
        `review`,
        `test`,
    ]);
});

it(`folds what doesn't fit into +N, keeping the stamps that need you`, async () => {
    const el = await mount({ stamps: [SELF, REVIEW, TEST], max: 1 });
    expect(badges(el)).toEqual([`review`]);
    expect(stampsOf(el).textContent).toContain(`+2`);
});

it(`pulses a check that is running, with nothing beside it`, async () => {
    const el = await mount({ stamps: [{ kind: `review`, outcome: `running`, stale: false, by: `reviewer`, own: false }] });
    const badge = el.querySelector(`[data-stamp] [data-stamp-badge]`)!;
    expect(badge.getAttribute(`class`)).toContain(`animate-pulse`);
    expect(el.querySelector(`[data-stamp-mark]`)).toBeNull();
});
