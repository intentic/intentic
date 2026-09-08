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

// A receipt dismissed by Undo while hovered never fires mouseleave, so the dwell flag is stuck true; every later
// receipt is born paused until the card is hovered and released again.
it(`retires a receipt raised after an earlier one was dismissed under the pointer`, async () => {
    vi.useFakeTimers();
    const { say, receipt } = useNotifications();
    const root = await mountHost();

    say(`3 files deleted`, () => {});
    await nextTick();
    // Undo can only be pressed with the pointer on the card.
    cardOf(root).dispatchEvent(new MouseEvent(`mouseenter`));
    await nextTick();
    buttonLabelled(root, `Undo`).click();
    await nextTick();
    // Checked via the store, not the DOM: jsdom never resolves the leave transition, leaving stale text either way.
    expect(receipt.value).toBeUndefined();

    say(`Path copied`);
    await nextTick();
    expect(receipt.value?.title).toBe(`Path copied`);

    // Past the longest dwell either tone can ask for.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(receipt.value).toBeUndefined();
});

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

    // Leaving starts the dwell instead of ending the receipt immediately.
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
