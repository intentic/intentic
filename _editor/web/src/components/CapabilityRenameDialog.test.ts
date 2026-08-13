// @vitest-environment jsdom
//
// The name is the agent's handle for a connection, and this dialog is the only place it can be changed. What is
// pinned is the part a user can get wrong: the field starts from the name they are looking at, the button stays
// down until the name is both different and legal, and what leaves is the trimmed name — the daemon refuses a
// stray space, and it should never get the chance to.
import PrimeVue from "primevue/config";
import { expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
});

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
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
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

it(`starts from the current name, refuses an illegal or unchanged one, and emits the name trimmed`, async () => {
    document.body.innerHTML = ``;
    const dialog = mount();
    dialog.open();
    await nextTick();

    // The common edit is a word changed, not a name typed from nothing.
    expect(field().value).toBe(`reddit-work`);
    // Nothing to do yet: renaming something to what it is already called is not a rename.
    expect(renameButton().disabled).toBe(true);

    // The add form's rule, enforced in the same words before anything is sent.
    await type(`-nope`);
    expect(renameButton().disabled).toBe(true);
    field().dispatchEvent(new Event(`blur`));
    await nextTick();
    expect(document.body.textContent).toContain(`must start with a letter or digit`);

    await type(`  reddit-personal  `);
    expect(renameButton().disabled).toBe(false);
    renameButton().click();
    expect(dialog.renamed()).toEqual([`reddit-personal`]);
});
