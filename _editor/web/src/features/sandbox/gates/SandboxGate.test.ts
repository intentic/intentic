// Which page stands in front of the sandbox's own: a sandbox too old for this app gets its one page whatever else is
// true of it (connected and painted before, or not), and gives the pages back the moment a hello names a release at or
// above the floor. A refused account still comes first, since nothing past that door is this person's to update.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { OLDEST_SUPPORTED_DAEMON } from "@intentic/sandbox-contract";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";

const stub = (name: string) => ({ default: defineComponent({ render: () => h(`div`, { "data-gate": name }) }) });
jest.mock(`./SandboxTooOld.vue`, () => stub(`too-old`));
jest.mock(`./SandboxUnauthorized.vue`, () => stub(`unauthorized`));
jest.mock(`./SandboxWarming.vue`, () => stub(`warming`));
jest.mock(`./SandboxConnecting.vue`, () => stub(`connecting`));

const connection = ref<{ failure?: { kind: string } }>({});
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ reachable: ref(true), connection }) }));
jest.mock(`./established`, () => ({ useSandboxEstablished: () => computed(() => true) }));
jest.mock(`../overview/useSandboxAvailability`, () => ({ useSandboxAvailability: () => computed(() => `ready`) }));

const { setDaemonVersion } = await import("../../../client/sandbox/daemon/useDaemonVersion");
const { default: SandboxGate } = await import("./SandboxGate.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxGate, null, { default: () => h(`div`, { "data-page": `` }) }) });
    app.mount(el);
    await nextTick();
    return el;
};
const shown = (el: HTMLElement): string | undefined =>
    el.querySelector(`[data-page]`) === null ? (el.querySelector(`[data-gate]`)?.getAttribute(`data-gate`) ?? undefined) : `page`;

beforeEach(() => {
    resetSandboxScope();
    connection.value = {};
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
