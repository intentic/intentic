// @vitest-environment jsdom
//
// jsdom because both subjects are WHAT THE CARD PUTS ON SCREEN and what a click does before anything is revoked.
//
// The card named the machine holding sync and stopped there, so the reader's actual next question, which folder
// on that computer is this sandbox: had no answer anywhere but that machine's own terminal. And Disable sat one
// unguarded click from revoking every paired computer, in the corner of a card people open to READ their state.
import PrimeVue from "primevue/config";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// What this component's import chain reads at module eval: the app's environment (the daemon client) and a media
// query (the UI barrel's useDevice), exactly as SandboxComputers.test.ts cuts the same edge.

const syncingPath = ref<string | undefined>(`/home/ada/intentic/work`);
const disable = vi.fn(async () => {});
vi.mock(`../../composables/sandbox/useDesktopSync`, () => ({
    useDesktopSync: () => ({
        canOperate: ref(true),
        enrolled: ref(true),
        syncingFrom: ref(`radarsu-rog`),
        syncingPath,
        syncStopped: ref(false),
        syncLastSeen: ref(`just now`),
        revokedFrom: ref(undefined),
        available: ref(true),
        folder: ref(`~/intentic/work`),
        pairToken: ref(undefined),
        pairMode: ref(undefined),
        minting: ref(false),
        takeover: ref(false),
        linuxCommand: ref(``),
        windowsCommand: ref(``),
        desktopLink: ref(undefined),
        enable: async () => {},
        start: () => {},
        stop: () => {},
        disable,
    }),
}));
vi.mock(`../../components/ScriptSourceSwitch.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: DesktopSyncCard } = await import("./DesktopSyncCard.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(DesktopSyncCard) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    // The confirm is a PrimeVue Dialog underneath, and it reads the plugin's config while rendering.
    app.use(PrimeVue);
    app.mount(el);
    return el;
};

// The dialog teleports out of the card, so every assertion reads the whole document rather than the mount point.
const shown = (): string => document.body.textContent ?? ``;
const clickButton = async (label: string): Promise<void> => {
    const button = [...document.body.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim().includes(label));
    expect(button, `no button labelled ${label}`).toBeDefined();
    button?.click();
    await nextTick();
};

afterEach(() => {
    syncingPath.value = `/home/ada/intentic/work`;
    disable.mockClear();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The whole point: the machine's own report carries SYNC_DIR, and the card is where somebody reading their sync
// state is standing when they want it.
it(`names the folder on the computer that holds sync`, () => {
    mount();
    expect(shown()).toContain(`Folder on that computer`);
    expect(shown()).toContain(`/home/ada/intentic/work`);
});

// An enrolled machine that has never posted a report genuinely leaves this unknown: the daemon is never told
// SYNC_DIR. Saying so beats printing the folder the setup flow would have suggested, which the user could change.
it(`says the folder is unknown rather than guessing it`, () => {
    syncingPath.value = undefined;
    mount();
    expect(shown()).toContain(`Folder on that computer`);
    expect(shown()).toContain(`not reported yet`);
});

it(`does not revoke anything on the first click of Disable sync`, async () => {
    mount();
    await clickButton(`Disable sync`);
    expect(disable).not.toHaveBeenCalled();
    // And the dialog says what goes, naming the folder that stops syncing.
    expect(shown()).toContain(`Disable desktop sync?`);
    expect(shown()).toContain(`/home/ada/intentic/work`);
});

it(`revokes once the confirm is taken`, async () => {
    mount();
    await clickButton(`Disable sync`);
    // The dialog's own destructive button carries the same words as the card's; the last one in the document is
    // the dialog's, since it teleports to the end of <body>.
    const buttons = [...document.body.querySelectorAll(`button`)].filter((candidate) => candidate.textContent?.trim().includes(`Disable sync`));
    buttons.at(-1)?.click();
    await nextTick();
    expect(disable).toHaveBeenCalledTimes(1);
});

// Cancel is the way OUT: the reason the guard exists at all is that the pointer lands here by mistake. (The
// dialog's own dismissal is the kit's transition and is not this card's to assert.)
it(`leaves every pairing alone when the confirm is cancelled`, async () => {
    mount();
    await clickButton(`Disable sync`);
    await clickButton(`Cancel`);
    expect(disable).not.toHaveBeenCalled();
});
