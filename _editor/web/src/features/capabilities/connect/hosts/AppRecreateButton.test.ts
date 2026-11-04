// In the desktop app, Update now is a link the app runs on this computer. The card used to forget it at the press: the
// button went on offering "Update now" while the only sign of the run was a tile on the rail. It follows the app's own
// report of the run instead (`recreate:<slug>`), from the press to the run's end, and says how it ended when it failed.
import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { IconStub } from "@intentic/ui/testing";
import * as desktopOriginal from "../../../../app/environments/desktop";
import type { ProcessReport } from "../../../../app/environments/processes/processReport";

const links: string[] = [];
jest.mock(`../../../../app/environments/desktop`, () => ({
    ...desktopOriginal,
    desktopTakesProcesses: () => true,
    openDesktopLink: (link: string) => void links.push(link),
}));
// The app's list as this page hears it.
const list = ref<readonly ProcessReport[]>([]);
jest.mock(`../../../../models/processes/faceProcesses`, () => ({ useFaceProcesses: () => ({ list, act: () => undefined }) }));
jest.mock(`../../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: ref(`sb1`) }) }));

const { forgetRestarts, restartExpected } = await import("../../../../models/sandbox/live/sandboxRestart");
const { default: AppRecreateButton } = await import("./AppRecreateButton.vue");

let app: App | undefined;
let router: Router;

const settle = async (): Promise<void> => {
    await advanceTimersByTimeAsync(0);
    await nextTick();
};

const mount = (): void => {
    const el = document.createElement(`div`);
    document.body.append(el);
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:any(.*)*`, component: { render: () => null } }] });
    app = createApp({ render: () => h(AppRecreateButton, { slug: `sandbox-6a4ac`, action: `Update`, icon: `arrow-circle-up`, row: `` }) });
    app.component(`Icon`, IconStub);
    app.use(PrimeVue);
    app.use(router);
    app.mount(el);
};

const report = (over: Partial<ProcessReport>): ProcessReport => ({
    id: `recreate:sandbox-6a4ac`,
    kind: `recreate`,
    state: `running`,
    origin: `app`,
    subject: `sandbox-6a4ac`,
    step: `update`,
    ...over,
});

const button = (): HTMLButtonElement | null => document.body.querySelector(`button`);
const buttonNamed = (words: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === words);
const shown = (): string => document.body.textContent ?? ``;

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(async () => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    list.value = [];
    links.length = 0;
    // Lets any follow a test left pending give up, so the next test starts on a clean slate.
    await advanceTimersByTimeAsync(60_000);
    forgetRestarts();
    jest.useRealTimers();
});

it(`holds the button from the press through the app's run, saying where it stands, then lets go`, async () => {
    mount();
    button()?.click();
    await settle();
    expect(links).toEqual([`intentic://recreate?slug=sandbox-6a4ac`]);
    expect(button()?.textContent).toContain(`Update running…`);
    expect(shown()).toContain(`Handing it to the Intentic app…`);
    // The silence to come is a restart this press asked for, on every surface.
    expect(restartExpected(`sb1`)?.what).toBe(`Updating this sandbox`);

    list.value = [report({})];
    await settle();
    expect(shown()).toContain(`Updating this sandbox in the Intentic app.`);
    buttonNamed(`Show progress`)?.click();
    await settle();
    expect(router.currentRoute.value.fullPath).toBe(`/home?process=recreate:sandbox-6a4ac`);

    // A second press while it runs hands nothing more over.
    button()?.click();
    await settle();
    expect(links).toHaveLength(1);

    list.value = [report({ state: `done`, actions: [`dismiss`] })];
    await settle();
    expect(button()?.textContent).toContain(`Update now`);
    expect(shown()).not.toContain(`in the Intentic app.`);
    expect(restartExpected(`sb1`)).toBeUndefined();
});

it(`says an update the app could not do, with the app's reason`, async () => {
    mount();
    button()?.click();
    await settle();
    list.value = [report({})];
    await settle();
    list.value = [report({ state: `failed`, failure: `docker pull: no space left on device`, actions: [`dismiss`] })];
    await settle();
    expect(shown()).toContain(`Update didn't go through in the Intentic app.`);
    expect(shown()).toContain(`no space left on device`);
    expect(button()?.textContent).toContain(`Update now`);
});

it(`stops holding when the app never takes the press, and says so`, async () => {
    // An earlier run's ending on the list is not this press's.
    list.value = [report({ state: `done` })];
    mount();
    button()?.click();
    await settle();
    expect(button()?.textContent).toContain(`Update running…`);
    await advanceTimersByTimeAsync(15_000);
    await nextTick();
    expect(button()?.textContent).toContain(`Update now`);
    expect(shown()).toContain(`The Intentic app didn't pick this up.`);
    expect(restartExpected(`sb1`)).toBeUndefined();
});
