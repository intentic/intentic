// @vitest-environment jsdom
// The pane around a viewer's compare component: both sides' bytes fetched and handed over with the path, and a pair
// the component cannot draw as one turned into the two other readings, one press each.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

const fetched: string[] = [];
vi.mock("../../sandbox/client/sandboxClient", () => ({
    sandboxBlob: (path: string) => {
        fetched.push(path);
        return Promise.resolve(new Blob([path]));
    },
}));

const { default: CompareDiffView } = await import("./CompareDiffView.vue");

// A compare component that says what it was given and can be made to give up.
const Redline = defineComponent({
    props: { path: String, before: Blob, after: Blob },
    emits: [`failed`],
    setup: (props, { emit }) => () => h(`div`, [h(`span`, `REDLINE ${props.path} ${props.before?.size}/${props.after?.size}`), h(`button`, { id: `fail`, onClick: () => emit(`failed`, `Not a Word document.`) }, `fail`)]),
});

let app: App | undefined;
const asked: string[] = [];
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(CompareDiffView, {
                path: `spec.docx`,
                before: `/diff/raw?which=before`,
                after: `/diff/raw?which=after`,
                compare: () => Promise.resolve(Redline),
                onText: () => asked.push(`text`),
                onSides: () => asked.push(`sides`),
            }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const settle = async (): Promise<void> => {
    for (let index = 0; index < 4; index++) {
        await nextTick();
    }
};

beforeEach(() => {
    fetched.length = 0;
    asked.length = 0;
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`CompareDiffView`, () => {
    it(`fetches both sides and renders the compare component with them and the path`, async () => {
        const element = mount();
        await settle();
        expect(fetched).toEqual([`/diff/raw?which=before`, `/diff/raw?which=after`]);
        expect(element.textContent).toContain(`REDLINE spec.docx 22/21`);
    });

    it(`turns the component's refusal into the two readings that can still be had`, async () => {
        const element = mount();
        await settle();
        element.querySelector<HTMLButtonElement>(`#fail`)?.click();
        await settle();
        expect(element.textContent).toContain(`Not a Word document.`);
        const buttons = [...element.querySelectorAll(`button`)];
        buttons.find((button) => button.textContent?.includes(`Show the text instead`))?.click();
        buttons.find((button) => button.textContent?.includes(`Show both versions instead`))?.click();
        expect(asked).toEqual([`text`, `sides`]);
    });
});
