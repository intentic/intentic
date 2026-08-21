// @vitest-environment jsdom
//
// The one place a changed file gets its NAME, for both review lists, so what it draws is worth pinning
// directly rather than through whichever panel happens to mount it. The two lists had each written this out
// themselves and had already drifted: one drew a middle-truncated full path where the other drew a name and a
// dimmed directory, which is a file called two things on two screens.
import { afterEach, expect, it } from "vitest";
import { createApp, h, type App } from "vue";
import ChangeRowName from "./ChangeRowName.vue";

let app: App | undefined;

const render = (props: { path: string; label: string; named: boolean }): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(ChangeRowName, props) });
    // A tooltip is a directive in the real app; here it only has to not blow up.
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`names the file and trails its directory when nothing above says where it lives`, () => {
    const el = render({ path: `_editor/web/src/main.ts`, label: `intentic/_editor/web/src/main.ts`, named: false });
    expect(el.textContent).toContain(`main.ts`);
    expect(el.textContent).toContain(`_editor/web/src`);
});

// Under a module heading the directory is dropped whole: the heading already said it, and repeating the prefix
// on every row is exactly what module grouping exists to stop.
it(`drops the directory once a module heading carries it`, () => {
    const el = render({ path: `_editor/web/src/main.ts`, label: `intentic/_editor/web/src/main.ts`, named: true });
    expect(el.textContent?.trim()).toBe(`main.ts`);
});

it(`leaves a file at the repo root with nothing trailing it`, () => {
    const el = render({ path: `README.md`, label: `intentic/README.md`, named: false });
    expect(el.textContent?.trim()).toBe(`README.md`);
});
