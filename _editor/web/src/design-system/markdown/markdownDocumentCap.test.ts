// A DOCUMENT OVER ITS CAP IS NEVER SENT. The daemon refuses a system prompt past 20,000 characters, and a press that
// could only be refused read "Saving…", then "Not saved yet", with the old text quietly put back and no word of why.
// Mounted for real, with PrimeVue booted, since the claim is what the foot shows and whether Save can be pressed.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";
import { MarkdownDocument } from "@intentic/ui";
import { IconStub } from "@intentic/ui/testing";

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const mount = (text: string) => {
    const saved: string[] = [];
    const doc = ref<{ commit: () => void }>();
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({
        render: () =>
            h(MarkdownDocument, {
                ref: doc,
                modelValue: text,
                editable: true,
                save: `explicit`,
                stored: `short`,
                maxChars: 10,
                onSave: (value: string) => saved.push(value),
            }),
    });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.mount(host);
    return { root: host, saved, commit: () => doc.value?.commit() };
};

const saveButton = (root: HTMLElement): HTMLButtonElement =>
    [...root.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim() === `Save`)!;

test(`over the cap, Save rests before it is pressed and the foot says how much to cut`, async () => {
    const { root, saved, commit } = mount(`x`.repeat(13));
    await nextTick();

    expect(saveButton(root).disabled).toBe(true);
    expect(root.textContent).toContain(`3 characters over the 10-character limit`);

    // Ctrl-S reaches the same commit: it sends nothing the daemon could only refuse.
    commit();
    expect(saved).toEqual([]);
});

test(`one character over is said in the singular`, async () => {
    const { root } = mount(`x`.repeat(11));
    await nextTick();

    expect(root.textContent).toContain(`1 character over the 10-character limit`);
});

test(`at the cap it is a count, and the document saves`, async () => {
    const { root, saved, commit } = mount(`x`.repeat(10));
    await nextTick();

    expect(saveButton(root).disabled).toBe(false);
    expect(root.textContent).toContain(`10 / 10`);

    commit();
    expect(saved).toEqual([`x`.repeat(10)]);
});
