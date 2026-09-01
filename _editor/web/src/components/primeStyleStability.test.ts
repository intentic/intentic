// @vitest-environment jsdom
import { Button, installUi } from "@intentic/ui";
import { afterEach, expect, it } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";

let app: App | undefined;

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

/* PrimeVue's ripple directive reloads its core styles whenever a Button updates. The CSS is byte-for-byte
 * unchanged, but assigning style.textContent replaces its text node and makes Chrome DevTools rebuild the
 * selected element's Styles editor. Request-driven loading/disabled state updates buttons constantly, so pin
 * the real app-level plugin behavior here rather than testing a detached DOM helper. */
it(`does not rewrite an unchanged PrimeVue stylesheet when a button updates`, async () => {
    const label = ref(`Before request`);
    const root = document.createElement(`div`);
    document.body.append(root);
    app = createApp({ render: () => h(Button, { label: label.value }) });
    installUi(app);
    app.mount(root);
    await nextTick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const base = document.head.querySelector<HTMLStyleElement>(`style[data-primevue-style-id="base"]`);
    expect(base).not.toBeNull();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(base!, { childList: true });

    label.value = `After request`;
    await nextTick();
    observer.disconnect();

    expect(root.textContent).toContain(`After request`);
    expect(mutations).toEqual([]);
});

it(`loads every lazily reached PrimeVue component stylesheet during app install`, async () => {
    const root = document.createElement(`div`);
    document.body.append(root);
    app = createApp({ render: () => h(`div`) });
    installUi(app);
    app.mount(root);
    await nextTick();

    const loaded = new Set(
        [...document.head.querySelectorAll<HTMLStyleElement>(`style[data-primevue-style-id]`)].map((style) => style.dataset.primevueStyleId),
    );
    for (const component of [`button`, `checkbox`, `contextmenu`, `dialog`, `drawer`, `popover`, `toggleswitch`]) {
        expect(loaded).toContain(`${component}-variables`);
        expect(loaded).toContain(`${component}-style`);
    }
});
