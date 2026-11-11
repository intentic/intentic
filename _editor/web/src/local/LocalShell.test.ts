import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter, type Router, RouterView } from "vue-router";
import type { CloseQuestion } from "../features/workspace/tabs/useCloseGuard";
import { localHost, type LocalRepairSession } from "../app/environments/localHost";
import { useEditBuffers } from "../models/workspace/files/useEditBuffers";

// The window's close, held back by the app for unsaved edits, is answered by the shell whichever screen it is on: Files
// coming and going takes nothing with it. Until 2026-10-12 only Files listened, and a folder window left on This
// computer with an edit unsaved ignored its × and Alt+F4 altogether.

const CLOSE = `intentic://window?do=close&confirmed=1`;

// The rail's neighbours and the folder switch are someone else's: stood in for, so the shell is mounted on its own.
const Nothing = defineComponent({ render: () => null });
jest.mock(`../shell/AccountPanel.vue`, () => ({ default: Nothing }));
jest.mock(`./LocalAccountTile.vue`, () => ({ default: Nothing }));
jest.mock(`../features/sandbox/gates/SandboxSwitcher.vue`, () => ({ default: Nothing }));
jest.mock(`../shell/rail/OtherSandboxes.vue`, () => ({ default: Nothing }));
jest.mock(`./LocalMasterRail.vue`, () => ({ default: Nothing }));
jest.mock(`./LocalSectionPicker.vue`, () => ({ default: Nothing }));
// A tile as its section and the corner it carries, so the rail's contents can be read.
jest.mock(`../shell/rail/RailTile.vue`, () => ({
    default: defineComponent({
        props: { section: { type: String, required: true }, badge: { type: Object, default: undefined } },
        setup: (props: { section: string; badge: { running?: string; tone?: string } | undefined }) => () =>
            h(`a`, { "data-tile": props.section, "data-badge": props.badge?.running === undefined ? (props.badge?.tone ?? ``) : `running` }),
    }),
}));
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
    delete window.__INTENTIC_LOCAL_HOST__;
    resetSandboxScope();
});

const Files = defineComponent({ render: () => h(`p`, `files`) });
const ThisComputer = defineComponent({ render: () => h(`p`, `this computer`) });

const mountShell = async (at = `/workspace`): Promise<Router> => {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            {
                path: `/`,
                component: LocalShell,
                children: [
                    { path: `workspace`, component: Files },
                    { path: `device`, component: ThisComputer },
                    { path: `repair`, component: ThisComputer },
                ],
            },
        ],
    });
    el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(RouterView) });
    app.use(router);
    await router.push(at);
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

// Repair's tile comes and goes like the setup's: on the rail while the reader is on its page and while it works or waits
// for their Allow, so they can leave and come back; once it rests and they have left, it is gone.
test(`Repair's tile is on the rail while it is open or at work, and leaves once it rests elsewhere`, async () => {
    const session = ref<LocalRepairSession>({ state: `idle`, messages: [] });
    const quiet = async (): Promise<undefined> => undefined;
    window.__INTENTIC_LOCAL_HOST__ = { ...localHost(), repair: { session, start: quiet, send: quiet, answer: quiet, reset: quiet } };
    const router = await mountShell();
    const tile = (): string | null | undefined => el?.querySelector(`[data-tile="repair"]`)?.getAttribute(`data-badge`);
    const seen: (string | null | undefined)[] = [tile()];

    await router.push(`/repair`);
    await nextTick();
    seen.push(tile());
    session.value = { state: `thinking`, messages: [] };
    await router.push(`/workspace`);
    await nextTick();
    seen.push(tile());
    session.value = {
        state: `waiting`,
        messages: [{ id: `t`, role: `tool`, text: `Restart`, tool: { name: `sandbox_restart`, state: `needsApproval`, summary: `Restart`, approvalId: `ok-1` } }],
    };
    await nextTick();
    seen.push(tile());
    session.value = { state: `idle`, messages: [] };
    await nextTick();
    seen.push(tile());

    expect(seen).toEqual([undefined, ``, `running`, `warning`, undefined]);
});

// This computer's own page (the view the app marks `logo`, Devices) is the logo's to open, as a sandbox's settings are its
// logo's: it has no tile of its own. Unrolled onto every sandbox, the rail puts its sections away (LocalMasterRail.vue).
test(`This computer's own page has no tile, and the unrolled rail puts the section tiles away`, async () => {
    const { localRailUnrolled } = await import("../models/home/masterRail");
    const load = async () => ({ default: ThisComputer });
    window.__INTENTIC_LOCAL_HOST__ = {
        ...localHost(),
        views: [
            { path: `device`, section: `devices`, title: () => `Devices`, load, logo: true },
            { path: `passwords`, section: `passwords`, title: () => `Passwords`, load },
        ],
    };
    await mountShell();
    const tiles = (): string[] => [...(el?.querySelectorAll(`[data-tile]`) ?? [])].map((tile) => tile.getAttribute(`data-tile`) ?? ``);
    const folded = tiles();
    localRailUnrolled.value = true;
    await nextTick();
    const unrolled = tiles();
    localRailUnrolled.value = false;
    await nextTick();
    expect({ folded, unrolled, refolded: tiles() }).toEqual({ folded: [`workspace`, `passwords`], unrolled: [], refolded: [`workspace`, `passwords`] });
});

// Asked for from the workspace, This computer comes up wearing the rail the workspace had (local/railArrival.ts): read off
// the first address of a window built for the press, and off the route the app sends one already up. The word is taken
// off the address, and a press that names no rail leaves the rail as it is.
test(`This computer arrives wearing the rail the workspace had at the press`, async () => {
    const { localRailUnrolled } = await import("../models/home/masterRail");
    localRailUnrolled.value = false;
    // A navigation lands over more than a few microtasks: given real turns of the clock to land in.
    jest.useRealTimers();
    const settle = async (): Promise<void> => {
        for (let turn = 0; turn < 5; turn += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };
    const built = await mountShell(`/workspace?rail=unrolled`);
    await settle();
    const first = { unrolled: localRailUnrolled.value, at: built.currentRoute.value.fullPath };

    const navigate = async (path: string): Promise<{ unrolled: boolean; at: string }> => {
        window.dispatchEvent(new CustomEvent(`intentic:navigate`, { detail: { path } }));
        await settle();
        return { unrolled: localRailUnrolled.value, at: built.currentRoute.value.fullPath };
    };
    await built.push(`/device`);
    const folded = await navigate(`/workspace?rail=folded`);
    const unnamed = await navigate(`/device`);
    const unrolled = await navigate(`/workspace?rail=unrolled`);
    localRailUnrolled.value = false;
    jest.useFakeTimers();

    expect({ first, folded, unnamed, unrolled }).toEqual({
        first: { unrolled: true, at: `/workspace` },
        folded: { unrolled: false, at: `/workspace` },
        unnamed: { unrolled: false, at: `/device` },
        unrolled: { unrolled: true, at: `/workspace` },
    });
});
