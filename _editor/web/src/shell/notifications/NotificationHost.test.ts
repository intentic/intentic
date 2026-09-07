// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, nextTick, ref } from "vue";
import { hold, useNotifications } from "./notifications";
import NotificationHost from "./NotificationHost.vue";

let app: App | undefined;
let release: (() => void) | undefined;

afterEach(() => {
    app?.unmount();
    app = undefined;
    release?.();
    release = undefined;
    useNotifications().dismissReceipt();
    document.body.innerHTML = ``;
    vi.useRealTimers();
});

const mountHost = async (): Promise<HTMLElement> => {
    const root = document.createElement(`div`);
    document.body.append(root);
    app = createApp(NotificationHost);
    app.directive(`tooltip`, {});
    app.mount(root);
    await nextTick();
    return root;
};

// The lane's cards; the wrapper around them is the inert one (`pointer-events-none`).
const cardOf = (root: HTMLElement): Element => root.querySelector(`.pointer-events-auto`)!;
const buttonLabelled = (root: HTMLElement, label: string): HTMLButtonElement =>
    [...root.querySelectorAll(`button`)].find((button) => button.textContent?.includes(label))!;

/* A live condition commonly changes when a request lands. The host used to wrap the lane in TransitionGroup,
 * which inserted a hidden clone to probe its move class after that update; Chrome DevTools saw the real DOM
 * mutation and rebuilt every rule in the Styles pane. The words may change, the card identity must not. */
/* THE DWELL SURVIVES A RECEIPT DISMISSED UNDER THE POINTER.
 *
 * A receipt pauses while hovered, so the host holds a flag mirroring "the pointer is over the card", kept up to
 * date by the card's own mouseenter/mouseleave. The card is also the thing that goes away: pressing Undo retires
 * the receipt, and a hovered node that is REMOVED fires no mouseleave at all (checked in Chromium: removing the
 * hovered element dispatches enter on whatever replaces it and never leave on it). The press can only be made
 * with the pointer on the card, so it always ends with the flag reading true and no card under the pointer.
 *
 * Nothing resynchronises it. Every later receipt is therefore born paused: the watch declines to arm a dwell, so
 * the card never retires, and it cannot be recovered by waiting, only by hovering the stuck card and leaving it
 * again. One press on one Undo silently switches the whole lane's self-retirement off for the session. */
it(`retires a receipt raised after an earlier one was dismissed under the pointer`, async () => {
    vi.useFakeTimers();
    const { say, receipt } = useNotifications();
    const root = await mountHost();

    say(`3 files deleted`, () => {});
    await nextTick();
    // The pointer arrives on the card, which is the only way its Undo can be pressed.
    cardOf(root).dispatchEvent(new MouseEvent(`mouseenter`));
    await nextTick();
    buttonLabelled(root, `Undo`).click();
    await nextTick();
    // Read off the store rather than the lane: retiring IS the store going quiet, and the card's leave
    // transition never resolves under jsdom, which would otherwise leave the text standing either way.
    expect(receipt.value).toBeUndefined();

    say(`Path copied`);
    await nextTick();
    expect(receipt.value?.title).toBe(`Path copied`);

    // Past the longest dwell either tone can ask for.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(receipt.value).toBeUndefined();
});

// The other half of the same mechanism, and the reason it exists: the reach for an Undo must not be raced by
// the card's own dwell. Unpinned until now, which is what let the identity rewrite above go in without a net.
it(`holds a receipt for as long as the pointer is on it`, async () => {
    vi.useFakeTimers();
    const { say, receipt } = useNotifications();
    const root = await mountHost();

    say(`3 files deleted`, () => {});
    await nextTick();
    cardOf(root).dispatchEvent(new MouseEvent(`mouseenter`));
    await nextTick();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(receipt.value?.title).toBe(`3 files deleted`);

    // ...and leaving it starts the dwell rather than ending the receipt on the spot.
    cardOf(root).dispatchEvent(new MouseEvent(`mouseleave`));
    await nextTick();
    expect(receipt.value?.title).toBe(`3 files deleted`);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(receipt.value).toBeUndefined();
});

it(`updates a network-backed condition without inserting a probe card`, async () => {
    const message = ref(`Connecting`);
    release = hold(`network-test`, () => ({ kind: `condition`, title: message.value }));
    const root = document.createElement(`div`);
    document.body.append(root);
    app = createApp(NotificationHost);
    app.directive(`tooltip`, {});
    app.mount(root);
    await nextTick();

    const inserted: Element[] = [];
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof Element && node.getAttribute(`role`) === `status`) {
                    inserted.push(node);
                }
            }
        }
    });
    observer.observe(root, { childList: true, subtree: true });

    message.value = `Connected`;
    await nextTick();
    observer.disconnect();

    expect(root.textContent).toContain(`Connected`);
    expect(inserted).toEqual([]);
});
