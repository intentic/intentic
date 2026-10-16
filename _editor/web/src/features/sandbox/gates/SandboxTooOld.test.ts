// The page a sandbox too old for this app gets in place of its own: what is wrong in plain words (its version, and the
// oldest this app works with), the Sandbox page's own update card, and for a sandbox installed by hand the one-liner
// to run on its machine. A hosted sandbox has no machine of its owner's to run anything on, so it gets no command.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { OLDEST_SUPPORTED_DAEMON } from "@intentic/sandbox-contract";
import { installI18n } from "@intentic/ui/i18n";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

const active = ref<{ name?: string; hosted: object | null } | undefined>({ name: `workspace`, hosted: null });
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ active }) }));
const slug = ref<string | undefined>(`sandbox-3c469e9d6c58`);
jest.mock(`../environment/servingSlug`, () => ({ useServingSlug: () => slug }));
// The connected machine running it, when this sandbox reaches one; none unless a case says so.
const runsOn = ref<string | undefined>(undefined);
jest.mock(`../devices/useDevices`, () => ({ useHostRunning: () => runsOn }));
// The update card is the Sandbox page's own, with its own tests; here it only has to be there.
jest.mock(`../overview/version/SandboxUpdateCard.vue`, () => ({
    default: defineComponent({ render: () => h(`div`, { "data-update-card": `` }) }),
}));

const { setDaemonVersion } = await import("../../../client/sandbox/daemon/useDaemonVersion");
const { scriptSource } = await import("../../../app/environments/scriptCommand");
const { useOsPreference } = await import("@intentic/ui");
const { default: SandboxTooOld } = await import("./SandboxTooOld.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxTooOld) });
    app.component(`Icon`, IconStub);
    installI18n(app);
    app.mount(el);
    await nextTick();
    return el;
};

beforeEach(() => {
    resetSandboxScope();
    setDaemonVersion(`1.200.0:1760000000000`);
    scriptSource.value = `published`;
    useOsPreference().cmdOs.value = `unix`;
});

afterEach(() => {
    active.value = { name: `workspace`, hosted: null };
    slug.value = `sandbox-3c469e9d6c58`;
    runsOn.value = undefined;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`names the sandbox, the version it runs and the oldest this app works with, and offers the update`, async () => {
    const el = await mount();
    expect(el.querySelector(`[data-too-old]`)).not.toBeNull();
    expect(el.querySelector(`h2`)?.textContent).toContain(`workspace needs an update`);
    expect(el.textContent).toContain(`It runs version 1.200.0, and this app works with sandboxes from version ${OLDEST_SUPPORTED_DAEMON} on.`);
    expect(el.querySelector(`[data-update-card]`)).not.toBeNull();
    expect(el.querySelector(`pre`)?.textContent).toBe(`curl -fsSL https://intentic.dev/update/sandbox-3c469e9d6c58 | sh`);
    // Nothing here is the language of the code: no route, no daemon.
    expect(el.textContent).not.toMatch(/daemon|route|org\.policy/i);
});

it(`prints no command for a hosted sandbox, which the update card restarts through the platform`, async () => {
    active.value = { name: `workspace`, hosted: { region: `ams` } };
    const el = await mount();
    expect(el.querySelector(`[data-update-card]`)).not.toBeNull();
    expect(el.querySelector(`pre`)).toBeNull();
});

it(`still says what is wrong without a name for the sandbox`, async () => {
    active.value = undefined;
    const el = await mount();
    expect(el.querySelector(`h2`)?.textContent).toContain(`This sandbox needs an update`);
});

// The card above carries the Update press when this sandbox reaches its machine: the recipe stays, folded, for a card that
// has nothing to offer a daemon this old.
it(`folds the command away when this sandbox reaches the machine it runs on`, async () => {
    runsOn.value = `rog`;
    const el = await mount();
    const folded = el.querySelector(`details`);
    expect(folded?.querySelector(`summary`)?.textContent).toContain(`Run it by hand instead`);
    expect(folded?.querySelector(`pre`)?.textContent).toBe(`curl -fsSL https://intentic.dev/update/sandbox-3c469e9d6c58 | sh`);
    expect(el.textContent).not.toContain(`Installed it yourself?`);
});
