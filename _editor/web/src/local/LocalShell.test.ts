import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter, type Router, RouterView } from "vue-router";
import type { CloseQuestion } from "../features/workspace/tabs/useCloseGuard";
import { useEditBuffers } from "../features/workspace/files/useEditBuffers";

// The window's close, held back by the app for unsaved edits, is answered by the shell whichever screen it is on: Files
// coming and going takes nothing with it. Until 2026-10-12 only Files listened, and a folder window left on This
// computer with an edit unsaved ignored its × and Alt+F4 altogether.

const CLOSE = `intentic://window?do=close&confirmed=1`;

// The rail's neighbours and the folder switch are someone else's: stood in for, so the shell is mounted on its own.
const Nothing = defineComponent({ render: () => null });
jest.mock(`../shell/AccountPanel.vue`, () => ({ default: Nothing }));
jest.mock(`./LocalAccountTile.vue`, () => ({ default: Nothing }));
jest.mock(`./LocalPlaceSwitcher.vue`, () => ({ default: Nothing }));
jest.mock(`./LocalProject.vue`, () => ({ default: Nothing }));
jest.mock(`../shell/rail/RailTile.vue`, () => ({ default: Nothing }));
jest.mock(`./folderSwitch`, () => ({ takeFolderSwitches: () => () => undefined }));
jest.mock(`../client/auth/useAccount`, () => ({ useAccount: () => ({ user: ref(null) }) }));
jest.mock(`../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: ref(`local-folder`) }) }));
// The question as the shell asks it: open or not, what it names, and its two answers as buttons.
jest.mock(`../features/workspace/tabs/CloseGuardDialog.vue`, () => ({
    default: defineComponent({
        props: { open: Boolean, question: { type: Object, default: undefined } },
        emits: [`cancel`, `confirm`],
        setup:
            (props: { open: boolean; question: CloseQuestion | undefined }, { emit }) =>
            () =>
                props.open
                    ? h(`div`, { "data-test": `close-question` }, [
                          h(`span`, `${props.question?.what}: ${props.question?.paths.join(`,`)}`),
                          h(`button`, { "data-test": `keep`, onClick: () => emit(`cancel`) }),
                          h(`button`, { "data-test": `close`, onClick: () => emit(`confirm`) }),
                      ])
                    : null,
    }),
}));

const { default: LocalShell } = await import("./LocalShell.vue");

// Every link the page follows, as the app hears them; they leave a beat apart (desktop.ts `openDesktopLink`).
let heard: string[] = [];
const LINK_GAP_WALK_MS = 1_000;
const handed = (): string[] => {
    jest.advanceTimersByTime(LINK_GAP_WALK_MS);
    return [...heard];
};

let app: App | undefined;
let el: HTMLElement | undefined;
beforeEach(() => {
    jest.useFakeTimers();
    heard = [];
    window.__INTENTIC_DESKTOP__ = { version: `1.0.0`, installId: `id`, update: null };
    Object.defineProperty(document, `readyState`, { configurable: true, get: () => `complete` });
    stubGlobal(`location`, {
        get href(): string {
            return heard.at(-1) ?? ``;
        },
        set href(link: string) {
            heard.push(link);
        },
    });
});
afterEach(() => {
    jest.advanceTimersByTime(LINK_GAP_WALK_MS);
    jest.useRealTimers();
    app?.unmount();
    el?.remove();
    app = undefined;
    unstubAllGlobals();
    delete window.__INTENTIC_DESKTOP__;
    resetSandboxScope();
});

const Files = defineComponent({ render: () => h(`p`, `files`) });
const ThisComputer = defineComponent({ render: () => h(`p`, `this computer`) });

const mountShell = async (): Promise<Router> => {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            {
                path: `/`,
                component: LocalShell,
                children: [
                    { path: `workspace`, component: Files },
                    { path: `device`, component: ThisComputer },
                ],
            },
        ],
    });
    el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(RouterView) });
    app.use(router);
    await router.push(`/workspace`);
    app.mount(el);
    await router.isReady();
    await nextTick();
    return router;
};

const question = (): string | undefined => el?.querySelector(`[data-test="close-question"] span`)?.textContent ?? undefined;
const press = async (which: `keep` | `close`): Promise<void> => {
    el?.querySelector<HTMLButtonElement>(`[data-test="${which}"]`)?.click();
    await nextTick();
};
const askToClose = async (): Promise<void> => {
    window.dispatchEvent(new CustomEvent(`intentic:close-requested`));
    await nextTick();
};

test(`a close held back for unsaved edits is asked about on a screen other than Files, and answered from there`, async () => {
    const router = await mountShell();
    const { setBaseline, setBuffer } = useEditBuffers();
    setBaseline(`notes.md`, `on disk`);
    setBuffer(`notes.md`, `typed`);
    await router.push(`/device`);
    await nextTick();
    handed();
    heard = [];

    await askToClose();
    const asked = [el?.textContent?.includes(`this computer`), question()];
    await press(`keep`);
    const kept = [question(), handed()];
    await askToClose();
    await press(`close`);
    expect([asked, kept, handed()]).toEqual([
        [true, `window: notes.md`],
        [undefined, []],
        [CLOSE],
    ]);
});

test(`with nothing unsaved the close is agreed to at once, from any screen`, async () => {
    const router = await mountShell();
    await router.push(`/device`);
    await nextTick();
    handed();
    heard = [];
    await askToClose();
    expect([question(), handed()]).toEqual([undefined, [CLOSE]]);
});
