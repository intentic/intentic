// The recovery panel's other options for a sandbox of the owner's own machine: a restart and a rollback pressed on that
// machine through another of the owner's sandboxes that reaches it, and the two commands only when none does.
import "@intentic/testing/dom";
import type { Device } from "@intentic/sandbox-contract/schemas/devices";
import { installI18n } from "@intentic/ui/i18n";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { listedDevice } from "../../../testing/listedDevice";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import type { DiagnosisNotice } from "../diagnosis/presentation";

const SLUG = `sandbox-3c469e9d6c58`;
const active = ref(sandboxSummary({ id: `quiet`, name: `Quiet`, role: `owner` }));
const lab = sandboxSummary({ id: `lab`, name: `Lab`, role: `owner` });
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ active, sandboxes: computed(() => [active.value, lab]), select: jest.fn() }) }));
jest.mock(`../../../models/sandbox/environment/servingSlug`, () => ({ useServingSlug: () => computed(() => SLUG) }));
// A diagnosis with nothing pressed first: only the other options are under test here.
const stuck: DiagnosisNotice = { title: `Quiet isn't answering`, body: ``, waiting: false, tone: `warning`, chain: [], action: undefined, otherActions: [], findings: [], sayAtOnce: false };
const notice = ref<DiagnosisNotice>(stuck);
jest.mock(`./useVisibleOutage`, () => ({ useDiagnosisNotice: () => computed(() => notice.value), useVisibleOutage: () => ({}) }));
// Inside the desktop app, where the Repair button can be offered.
const desktopActual = await import(`../../../app/environments/desktop`);
jest.mock(`../../../app/environments/desktop`, () => ({ ...desktopActual, desktopVersion: () => `1.0.0` }));
const relays = ref<{ sandboxId: string; devices: Device[] }[]>([]);
const looking = ref(false);
jest.mock(`../live/useDeviceRelays`, () => ({ useDeviceRelays: () => ({ relays: computed(() => relays.value), looking, look: async () => {} }) }));
const manageDeviceSandbox = jest.fn(async () => `Restarted.`);
jest.mock(`../../../models/sandbox/devices/useDevices`, () => ({ manageDeviceSandbox }));
jest.mock(`../../../models/sandbox/live/sandboxRestart`, () => ({ expectRestart: () => () => {} }));
jest.mock(`../overview/version/HostedRollbackDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { scriptSource } = await import("../../../app/environments/scriptCommand");
const { useOsPreference } = await import("@intentic/ui");
const { default: SandboxRecovery } = await import("./SandboxRecovery.vue");

const rog = listedDevice({ key: `rog`, label: `rog`, hostId: `rog`, online: true, sandboxes: [{ slug: SLUG, container: `intentic-sandbox-${SLUG}`, running: false, image: `img` }] });

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const page = defineComponent({ render: () => h(`div`) });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:any(.*)*`, component: page }] });
    await router.push(`/`);
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxRecovery) });
    app.use(router);
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    installI18n(app);
    app.mount(el);
    await nextTick();
    return el;
};
const buttonsOf = (el: HTMLElement): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>(`details button`)];

beforeEach(() => {
    scriptSource.value = `published`;
    useOsPreference().cmdOs.value = `unix`;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    relays.value = [];
    looking.value = false;
    notice.value = stuck;
    manageDeviceSandbox.mockClear();
    document.body.innerHTML = ``;
});

it(`presses a restart on the machine through the sibling that reaches it, instead of printing the command`, async () => {
    relays.value = [{ sandboxId: `lab`, devices: [rog] }];
    const el = await mount();
    expect(buttonsOf(el).map((button) => button.textContent?.trim())).toEqual([`Restart it on rog`, `Roll back on rog`, `manage this sandbox from its Devices page`]);
    expect(el.querySelector(`details pre`)).toBeNull();
    expect(el.textContent).toContain(`Through Lab, which reaches rog:`);
    buttonsOf(el)[0]?.click();
    await nextTick();
    expect(manageDeviceSandbox).toHaveBeenCalledWith(`rog`, SLUG, `restart`, expect.objectContaining({ at: `lab` }));
});

// A rollback changes the version it runs, so it is asked first; nothing reaches the machine until the owner says yes.
it(`asks before a rollback, and sends nothing on the first press`, async () => {
    relays.value = [{ sandboxId: `lab`, devices: [rog] }];
    const el = await mount();
    buttonsOf(el)[1]?.click();
    await nextTick();
    expect(document.body.textContent).toContain(`Roll back on rog?`);
    expect(manageDeviceSandbox).toHaveBeenCalledTimes(0);
});

it(`says it is looking while the siblings are asked, rather than printing a command it may take back`, async () => {
    looking.value = true;
    const el = await mount();
    expect(el.textContent).toContain(`Looking for another of your sandboxes that reaches its computer`);
    expect(el.querySelector(`details pre`)).toBeNull();
});

it(`prints the two commands when no sandbox of the owner's reaches that machine`, async () => {
    const el = await mount();
    expect([...el.querySelectorAll(`details pre`)].map((pre) => pre.textContent)).toEqual([
        `curl -fsSL https://intentic.dev/restart/${SLUG} | sh`,
        `curl -fsSL https://intentic.dev/rollback/${SLUG} | sh`,
    ]);
});

// A sandbox asleep and waking (or a machine mending it) is a wait, not a fault: nothing beside it says "repair".
it(`offers no Repair and no other options while the diagnosis is still a wait`, async () => {
    notice.value = { ...stuck, title: `Waking Quiet`, waiting: true, tone: `info` };
    const el = await mount();
    expect(el.textContent).not.toContain(`Repair`);
    expect(el.querySelector(`details`)).toBeNull();
});

it(`offers Repair and the other options once the wait has run out`, async () => {
    const el = await mount();
    expect(el.textContent).toContain(`Repair`);
    expect(el.querySelector(`details`)).not.toBeNull();
});

// A wait the diagnosis itself attached an offer to (busy for long) keeps that offer.
it(`keeps an offer the diagnosis attached to a wait`, async () => {
    notice.value = { ...stuck, waiting: true, tone: `info`, otherActions: [`restart-hosted`] };
    const el = await mount();
    expect(el.querySelector(`details`)).not.toBeNull();
    expect(el.textContent).not.toContain(`Repair`);
});
