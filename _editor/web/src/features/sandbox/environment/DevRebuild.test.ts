// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const hostId = ref<string | undefined>(`host-1`);
vi.mock(`../devices/useDevices`, () => ({
    useHostRunning: () => hostId,
    useDevices: () => ({ devices: ref([]) }),
    runDeviceCommand: vi.fn(),
}));

const { default: DevRebuild } = await import("./DevRebuild.vue");

let app: App | undefined;

const mount = (props: { slug: string; base: string; root?: string }): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(DevRebuild, props) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    return el;
};

beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, `getBoundingClientRect`).mockReturnValue({
        top: 100,
        left: 100,
        width: 120,
        height: 36,
        right: 220,
        bottom: 136,
        x: 100,
        y: 100,
        toJSON: () => ({}),
    } as DOMRect);
});

afterEach(() => {
    hostId.value = `host-1`;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    vi.restoreAllMocks();
});

it(`renders button and reveals command overlay with cost on focus`, async () => {
    const root = `/home/radarsu/intentic/workspace-82789f4106b4/intentic`;
    const el = mount({ slug: `demo`, base: `intentic-sandbox:dev`, root });
    const button = el.querySelector(`button`);

    expect(button).not.toBeNull();

    const trigger = el.querySelector(`div.inline-flex`);
    expect(trigger).not.toBeNull();

    trigger?.dispatchEvent(new FocusEvent(`focusin`));
    await nextTick();

    const overlay = document.querySelector(`.ui-anchored-right`);
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain(`pnpm rebuild:sandbox demo`);
    expect(overlay?.textContent).toContain(root);
    expect(overlay?.textContent).toContain(`Builds the image while you keep working`);
});
