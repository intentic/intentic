// @vitest-environment jsdom
//
// THE TWO SILENCES THIS PANE COVERS. An empty workspace is somebody who has just finished setup and has no code
// in yet: for them this pane is the whole product, and every way in has to be on it. A workspace with code and
// no file open is a reader between files, who needs the drop target and nothing else. Showing either screen in
// the other's state is the failure worth a test: the newcomer offered only a file upload (what this replaced),
// or a working developer greeted by a get-started pitch every time they close their last tab.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { queryClient } from "../../composables/queryPersistence";
import WorkspaceEmptyState from "./WorkspaceEmptyState.vue";

const mount = (empty: boolean): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    const app = createApp({ render: () => h(WorkspaceEmptyState, { empty }) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    return el;
};

const buttonSaying = (el: HTMLElement, text: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(text));

it(`offers every way of getting code in while the workspace is empty`, () => {
    const el = mount(true);

    expect(buttonSaying(el, `Clone`)).toEqual(expect.any(Object));
    expect(buttonSaying(el, `Upload`)).toEqual(expect.any(Object));
    expect(buttonSaying(el, `Ask`)).toEqual(expect.any(Object));
    expect(el.querySelectorAll(`button`).length).toBeGreaterThanOrEqual(3);
    expect(mount(false).textContent).not.toBe(el.textContent);
});

it(`opens the clone field in place, and refuses to submit an empty address`, async () => {
    const el = mount(true);

    buttonSaying(el, `Clone a repository`)!.click();
    await nextTick();

    const field = el.querySelector<HTMLInputElement>(`#clone-url`);
    expect(field).not.toBeNull();
    expect(field!.value).toBe(``);
    expect(buttonSaying(el, `Clone`)!.disabled).toBe(true);
});

it(`shows a workspace that HAS code only the drop target: this pane is not a tutorial for people mid-work`, () => {
    const el = mount(false);

    expect(el.textContent).not.toBe(mount(true).textContent);
    expect(buttonSaying(el, `Clone`)).toBeUndefined();
    expect(buttonSaying(el, `Ask`)).toBeUndefined();
    expect(el.querySelector(`input`)).toBeNull();
});
