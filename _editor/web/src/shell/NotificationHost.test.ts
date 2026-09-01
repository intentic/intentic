// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { type App, createApp, nextTick, ref } from "vue";
import { hold, useNotifications } from "../composables/notifications";
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
});

/* A live condition commonly changes when a request lands. The host used to wrap the lane in TransitionGroup,
 * which inserted a hidden clone to probe its move class after that update; Chrome DevTools saw the real DOM
 * mutation and rebuilt every rule in the Styles pane. The words may change, the card identity must not. */
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
