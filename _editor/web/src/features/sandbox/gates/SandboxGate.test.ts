// Which page stands in front of the sandbox's own: a sandbox too old for this app gets its one page whatever else is
// true of it (connected and painted before, or not), and gives the pages back the moment a hello names a release at or
// above the floor. A refused account still comes first, since nothing past that door is this person's to update.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { OLDEST_SUPPORTED_DAEMON } from "@intentic/sandbox-contract/state/daemon-floor";
import { homePath, insidePath, isSandboxPage, page, PAGE_PATTERNS, type PageName } from "@intentic/sandbox-contract/app-routes";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter, type RouteRecordRaw } from "vue-router";

const stub = (name: string) => ({ default: defineComponent({ render: () => h(`div`, { "data-gate": name }) }) });
jest.mock(`./SandboxTooOld.vue`, () => stub(`too-old`));
jest.mock(`./SandboxUnauthorized.vue`, () => stub(`unauthorized`));
jest.mock(`./SandboxWarming.vue`, () => stub(`warming`));
jest.mock(`./SandboxConnecting.vue`, () => stub(`connecting`));

const connection = ref<{ failure?: { kind: string } }>({});
const reachable = ref(true);
const established = ref(true);
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ reachable, connection }) }));
jest.mock(`./established`, () => ({ useSandboxEstablished: () => computed(() => established.value) }));
jest.mock(`../overview/useSandboxAvailability`, () => ({ useSandboxAvailability: () => computed(() => `ready`) }));

const { setDaemonVersion } = await import("../../../client/sandbox/daemon/useDaemonVersion");
const { default: SandboxGate } = await import("./SandboxGate.vue");

// The shell's pages in both frames, each record saying its frame and page as the real table does.
const BOX = `a1b2c3d4e5f6`;
const view = defineComponent({ render: () => null });
const routes: RouteRecordRaw[] = [
    { path: `/home/:sandbox?`, meta: { frame: `home` }, component: view },
    // SAFETY: PAGE_PATTERNS is a const literal whose own keys are exactly PageName; Object.entries only widens them.
    ...(Object.entries(PAGE_PATTERNS) as [PageName, string][]).flatMap(([name, pattern]): RouteRecordRaw[] => [
        { path: `/s/:sandbox/${pattern}`, meta: { frame: `inside`, page: name }, component: view },
        { path: isSandboxPage(name) ? `/home/:sandbox/${pattern}` : `/home/${pattern}`, meta: { frame: `home`, page: name }, component: view },
    ]),
];

let app: App | undefined;
let router: ReturnType<typeof createRouter>;
const mount = async (path = insidePath(BOX, page.agents())): Promise<HTMLElement> => {
    router = createRouter({ history: createMemoryHistory(), routes });
    await router.push(path);
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxGate, null, { default: () => h(`div`, { "data-page": `` }) }) });
    app.use(router);
    app.mount(el);
    await nextTick();
    return el;
};
const shown = (el: HTMLElement): string | undefined =>
    el.querySelector(`[data-page]`) === null ? (el.querySelector(`[data-gate]`)?.getAttribute(`data-gate`) ?? undefined) : `page`;

beforeEach(() => {
    resetSandboxScope();
    connection.value = {};
    reachable.value = true;
    established.value = true;
    setDaemonVersion(undefined);
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`stands the too-old page in front of a sandbox below the floor, and gives the pages back once it updates`, async () => {
    setDaemonVersion(`1.200.0:1`);
    const el = await mount();
    expect(shown(el)).toBe(`too-old`);
    setDaemonVersion(`${OLDEST_SUPPORTED_DAEMON}:2`);
    await nextTick();
    expect(shown(el)).toBe(`page`);
});

it(`lets a checkout's build and a sandbox of unknown age through`, async () => {
    setDaemonVersion(`0.0.0:1`);
    const el = await mount();
    expect(shown(el)).toBe(`page`);
    setDaemonVersion(undefined);
    await nextTick();
    expect(shown(el)).toBe(`page`);
});

it(`keeps a refused account's page first`, async () => {
    setDaemonVersion(`1.200.0:1`);
    connection.value = { failure: { kind: `forbidden` } };
    const el = await mount();
    expect(shown(el)).toBe(`unauthorized`);
});

it(`opens settings from Home with unfinished setup, and still gates sandbox pages, in Home's frame too`, async () => {
    reachable.value = false;
    established.value = false;
    const el = await mount(homePath());
    expect(shown(el)).toBe(`page`);
    await router.push(homePath(undefined, page.account()));
    expect(shown(el)).toBe(`page`);
    await router.push(homePath(undefined, page.account(`appearance`)));
    expect(shown(el)).toBe(`page`);
    await router.push(homePath(BOX, page.agents()));
    expect(shown(el)).toBe(`connecting`);
    await router.push(insidePath(BOX, page.agents()));
    expect(shown(el)).toBe(`connecting`);
});

it.each([
    homePath(undefined, page.account()),
    homePath(undefined, page.account(`appearance`)),
    insidePath(BOX, page.account(`billing`)),
    insidePath(BOX, page.account(`tokens`)),
    homePath(undefined, page.deletedSandboxes()),
    insidePath(BOX, page.deletedSandboxes()),
])(`opens a direct visit to %s even when the sandbox is unavailable, too old or refuses access`, async (path) => {
    reachable.value = false;
    established.value = false;
    setDaemonVersion(`1.200.0:1`);
    connection.value = { failure: { kind: `forbidden` } };
    const el = await mount(path);
    expect(shown(el)).toBe(`page`);
    await router.push(insidePath(BOX, page.sandboxSettings()));
    expect(shown(el)).toBe(`unauthorized`);
    connection.value = {};
    await nextTick();
    expect(shown(el)).toBe(`too-old`);
});
