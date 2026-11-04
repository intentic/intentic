// CTRL+ENTER (⌘+ENTER) IS SAVE'S under `explicit`, as Ctrl-S is: a document field keeps Enter for its blocks, so the chord every
// other field with a Save beside it answers has to reach this one's too. Under the other policies there is no Save of
// the document's own, and the chord goes on to whatever the caller wraps it in (a draft's Create).
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick } from "vue";
import { MarkdownDocument } from "@intentic/ui";
import { IconStub } from "@intentic/ui/testing";

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const mount = (save: `explicit` | `none`) => {
    const saved: string[] = [];
    const heard: boolean[] = [];
    const host = document.createElement(`div`);
    // The caller's own surface, to see what the chord does once the document is done with it.
    host.addEventListener(`keydown`, (event) => heard.push(event.defaultPrevented));
    document.body.append(host);
    app = createApp({
        render: () => h(MarkdownDocument, { modelValue: `edited`, editable: true, save, stored: `on disk`, onSave: (value: string) => saved.push(value) }),
    });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.mount(host);
    const press = (init: KeyboardEventInit): void => {
        const field = host.querySelector(`[contenteditable], textarea`);
        if (field === null) {
            throw new Error(`no field to type in`);
        }
        field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true, cancelable: true, ...init }));
    };
    return { saved, heard, press };
};

// jsdom is not a Mac, so Ctrl is the primary modifier here; on a Mac it is ⌘, as the document's other chords read it.
test(`Ctrl+Enter saves an explicit document and stops there, where Enter only starts a block`, async () => {
    const { saved, heard, press } = mount(`explicit`);
    await nextTick();
    press({});
    expect(saved).toEqual([]);
    press({ ctrlKey: true });
    expect(saved).toEqual([`edited`]);
    expect(heard.at(-1)).toBe(true);
});

test(`a document with no Save of its own hands the chord on to its caller`, async () => {
    const { saved, heard, press } = mount(`none`);
    await nextTick();
    press({ ctrlKey: true });
    expect(saved).toEqual([]);
    expect(heard).toEqual([false]);
});
