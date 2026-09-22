//
// THE ONE SILENCE THIS PANE COVERS. An empty workspace is somebody who has just finished setup and has no code in
// yet: for them this pane is the whole product, and every way in has to be on it. The other silence — a workspace
// with code and no file open — is the home's, and EditorPane picks between them on `empty`, so a working developer
// closing their last tab never lands here. The failure worth a test is the newcomer offered only a file upload,
// which is what this pane replaced.
import "@intentic/testing/dom";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { it, expect } from "bun:test";
import { createApp, h, nextTick } from "vue";
import { queryClient } from "../../../lib/queryPersistence";
import WorkspaceEmptyState from "./WorkspaceEmptyState.vue";
import { IconStub } from "@intentic/ui/testing";

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    const app = createApp({ render: () => h(WorkspaceEmptyState) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    return el;
};

const buttonSaying = (el: HTMLElement, text: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(text));

it(`offers every way of getting code in`, () => {
    const el = mount();

    expect(buttonSaying(el, `Clone`)).toEqual(expect.any(Object));
    expect(buttonSaying(el, `Upload`)).toEqual(expect.any(Object));
    expect(buttonSaying(el, `Ask`)).toEqual(expect.any(Object));
    expect(el.querySelectorAll(`button`).length).toBeGreaterThanOrEqual(3);
});

it(`opens the clone field in place, and refuses to submit an empty address`, async () => {
    const el = mount();

    buttonSaying(el, `Clone a repository`)!.click();
    await nextTick();

    const field = el.querySelector<HTMLInputElement>(`#clone-url`);
    expect(field).not.toBeNull();
    expect(field!.value).toBe(``);
    expect(buttonSaying(el, `Clone`)!.disabled).toBe(true);
});

// Last, since answering is remembered for the rest of this file's module: the card is the newcomer's one question.
it(`asks the newcomer how they work, once`, async () => {
    const el = mount();
    expect(el.textContent).toContain(`How will you work here?`);

    buttonSaying(el, `I write code`)!.click();
    await nextTick();

    expect(el.textContent).not.toContain(`How will you work here?`);
    expect(localStorage.getItem(`ui-audience`)).toBe(`developer`);
    expect(mount().textContent).not.toContain(`How will you work here?`);
});
