// @vitest-environment jsdom
// Renaming is this dialog's only path: the field starts from the current name, the button stays disabled until it
// actually differs, and typed spaces/punctuation are repaired the same way the add form does, shown before submit.
import PrimeVue from "primevue/config";
import { expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const { default: CapabilityRenameDialog } = await import("./CapabilityRenameDialog.vue");

// PrimeVue's Dialog teleports to the body, so everything below is queried there rather than under the mount.
const mount = (): { open: () => void; renamed: () => string[] } => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const visible = ref(false);
    const renamed: string[] = [];
    const app = createApp({
        render: () =>
            h(CapabilityRenameDialog, {
                visible: visible.value,
                id: `reddit-work`,
                onRename: (to: string) => renamed.push(to),
            }),
    });
    app.component(`Icon`, IconStub);
    app.use(PrimeVue);
    app.mount(el);
    return {
        open: () => {
            visible.value = true;
        },
        renamed: () => renamed,
    };
};

const field = (): HTMLInputElement => document.body.querySelector(`input`)!;
const renameButton = (): HTMLButtonElement =>
    [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Rename`)!;

const type = async (value: string): Promise<void> => {
    field().value = value;
    field().dispatchEvent(new Event(`input`));
    await nextTick();
};

it(`starts from the current name, repairs what is typed, and refuses only an unchanged or empty one`, async () => {
    document.body.innerHTML = ``;
    const dialog = mount();
    dialog.open();
    await nextTick();

    // The common edit is a word changed, not a name typed from nothing.
    expect(field().value).toBe(`reddit-work`);
    // Nothing to do yet: renaming something to what it is already called is not a rename.
    expect(renameButton().disabled).toBe(true);

    // A name with nothing usable in it is the one thing left to refuse.
    await type(`  `);
    expect(renameButton().disabled).toBe(true);
    field().dispatchEvent(new Event(`blur`));
    await nextTick();
    expect(renameButton().disabled).toBe(true);

    // Spaces/punctuation are repaired, not refused; the line under the field shows what will actually be used before
    // submit.
    await type(`Reddit Personal`);
    expect(renameButton().disabled).toBe(false);
    expect(document.body.textContent).toContain(`Reddit-Personal`);
    renameButton().click();
    expect(dialog.renamed()).toEqual([`Reddit-Personal`]);
});
