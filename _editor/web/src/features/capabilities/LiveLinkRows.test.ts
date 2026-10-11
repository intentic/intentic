// A tunnel's dial outlives the card that pressed it: a reader who leaves while it dials comes back to it still dialling,
// and to the gateway's refusal with the one-time-code field one press away, instead of a Connect button offered again.
import "@intentic/testing/dom";
import type { VpnLink } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const OFFICE = { id: `office`, provider: `fortinet`, state: `idle`, routes: [], autoConnect: false } as unknown as VpnLink;
const links = ref<VpnLink[]>([OFFICE]);
const open = jest.fn<(id: string, onLine?: (message: string) => void, otp?: string) => Promise<void>>(async () => undefined);
jest.mock(`../sandbox/devices/useLiveLinks`, () => ({
    useLiveLinks: () => ({ links, error: ref(undefined), open, close: jest.fn(async () => undefined) }),
}));

const { default: LiveLinkRows } = await import("./LiveLinkRows.vue");
const { forgetOperations } = await import("../../workbench/operations/operations");

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const instance = { id: `office`, kind: `vpn` as const, status: { state: `active` as const }, config: {}, secrets: [] };
    app = createApp({ render: () => h(LiveLinkRows, { kind: `vpn`, instances: [instance] }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.component(`RouterLink`, defineComponent({ setup: (_props, { slots }) => () => h(`a`, slots[`default`]?.()) }));
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};
const unmount = (): void => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
};
const buttonNamed = (el: HTMLElement, words: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === words);

afterEach(() => {
    unmount();
    open.mockReset();
    forgetOperations();
});

it(`comes back to a dial still running, then to the gateway asking for a code`, async () => {
    let refuse: (error: Error) => void = () => undefined;
    open.mockImplementationOnce((_id, onLine) => {
        onLine?.(`negotiating with vpn.acme.dev`);
        return new Promise((_resolve, reject) => (refuse = reject));
    });
    buttonNamed(mount(), `Connect`)?.click();
    await nextTick();
    unmount();

    let el = mount();
    await nextTick();
    expect(el.textContent).toContain(`negotiating with vpn.acme.dev`);
    buttonNamed(el, `Connect`)?.click();
    expect(open).toHaveBeenCalledTimes(1);
    unmount();

    refuse(new Error(`The gateway wants a one-time code (2FA).`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    el = mount();
    await nextTick();
    expect(el.textContent).toContain(`The gateway wants a one-time code (2FA).`);
    expect(el.textContent).toContain(`Enter a one-time code`);
});
