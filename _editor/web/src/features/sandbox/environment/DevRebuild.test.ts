// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const hostId = ref<string | undefined>(`host-1`);
vi.mock(`../devices/useDevices`, () => ({
    useHostRunning: () => hostId,
    useDevices: () => ({ devices: ref([]) }),
    runDeviceCommand: vi.fn(),
}));

const { default: DevRebuild } = await import("./DevRebuild.vue");

let app: App | undefined;
interface TooltipCapture {
    value: unknown;
    modifiers: Record<string, boolean | undefined>;
}
let lastTooltip: TooltipCapture | undefined;

const mount = (props: { slug: string; base: string; root?: string }): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    lastTooltip = undefined;
    app = createApp({ render: () => h(DevRebuild, props) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {
        mounted: (_el, binding) => {
            lastTooltip = { value: binding.value, modifiers: binding.modifiers };
        },
    });
    app.mount(el);
    return el;
};

afterEach(() => {
    hostId.value = `host-1`;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`attaches rebuild explanation and cost to the right-side tooltip of the button`, () => {
    const root = `/home/radarsu/intentic/workspace-82789f4106b4/intentic`;
    const el = mount({ slug: `demo`, base: `intentic-sandbox:dev`, root });
    const button = el.querySelector(`button`);

    expect(button).not.toBeNull();
    expect(lastTooltip?.modifiers[`right`]).toBe(true);
    expect(lastTooltip?.value).toBe(
        `Runs pnpm rebuild:sandbox in ${root} on the host. Builds the image while you keep working (may take minutes), then restarts (~30s). /work is kept.`,
    );

    const paragraphs = [...el.querySelectorAll(`p`)].map((p) => p.textContent);
    expect(paragraphs.some((text) => text?.includes(`Runs pnpm rebuild:sandbox`))).toBe(false);
});
