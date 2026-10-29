// Who is offered the connect-a-server form. Where the daemon mints codes, the command carries a single-use code rather
// than the platform's connect token, and asking for one is Full access's (the daemon's floor for
// `POST /system/enroll/code`): the owner and Full access get the form, anybody below is told whose step it is. Where it
// cannot (local dev, a daemon older than codes), the command carries the connect token, which the platform hands the
// owner alone, so everybody without it is told the owner connects servers there.
import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, ref } from "vue";

const known = ref(true);
const mayMint = ref(true);
jest.mock(`../../client/sandbox/access/useAccess`, () => ({
    useAccess: () => ({ known, can: (route: string) => known.value && route === `POST /system/enroll/code` && mayMint.value }),
}));
const daemonUrl = ref<string | undefined>(`https://vivid-rowan.intentic.dev`);
const active = ref<{ token: string | null; providedAddress: boolean } | undefined>({ token: null, providedAddress: true });
jest.mock(`../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ active, daemonUrl }) }));
jest.mock(`../../features/extensions/useInventory`, () => ({ useInventory: () => ({ entries: ref([]), refetch: () => undefined }) }));
jest.mock(`../../workbench/workspace-events/fileEvents`, () => ({ onFilesChanged: () => ({ dispose: () => undefined }) }));
jest.mock(`../../client/sandbox/sandboxRaw`, () => ({ sandboxRaw: jest.fn() }));
jest.mock(`../../components/RunCommand.vue`, () => ({ default: { template: `<div data-run-command />` } }));

const { default: ConnectHost } = await import("./ConnectHost.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ConnectHost) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    await nextTick();
    return element;
};
const form = (element: HTMLElement): HTMLFormElement | null => element.querySelector(`form`);

beforeEach(() => {
    known.value = true;
    mayMint.value = true;
    daemonUrl.value = `https://vivid-rowan.intentic.dev`;
    active.value = { token: null, providedAddress: true };
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`offers Full access the form where the daemon mints a code, though the platform gave them no connect token`, async () => {
    const element = await mount();
    expect(form(element)).not.toBeNull();
    expect(element.textContent).toContain(`Show the command`);
    expect(element.textContent).not.toContain(`can connect a server`);
});

it(`tells somebody below Full access whose step it is, with no form`, async () => {
    mayMint.value = false;
    const element = await mount();
    expect(form(element)).toBeNull();
    expect(element.textContent).toContain(`Only the owner or someone with Full access can connect a server to this sandbox.`);
});

it(`keeps the form while the reader's access is still loading, and lets the daemon decide`, async () => {
    known.value = false;
    const element = await mount();
    expect(form(element)).not.toBeNull();
});

it(`keeps the token-carrying form to the owner where no code can be minted`, async () => {
    daemonUrl.value = `http://localhost:47145`;
    const member = await mount();
    expect(form(member)).toBeNull();
    expect(member.textContent).toContain(`Only this sandbox's owner can connect a server`);
    app?.unmount();
    document.body.innerHTML = ``;

    active.value = { token: `connect-token`, providedAddress: true };
    const owner = await mount();
    expect(form(owner)).not.toBeNull();
});
