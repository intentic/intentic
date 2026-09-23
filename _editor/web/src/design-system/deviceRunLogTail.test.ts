//
// WHERE A DEVICE LOG OPENS. The run outlives the pane that draws it — a rebuild keeps going while the reader is in
// another section, and its lines are kept outside the component — so a revisit mounts on a log that is already long.
// It used to open at line one, which is the one part of a build nobody is waiting on.
import "@intentic/testing/dom";
import { DeviceRunLog } from "@intentic/ui";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, ref } from "vue";

const mounted: { app: App; host: HTMLElement }[] = [];
// The pane's own measurements, which jsdom does no layout to produce.
let box: { top: number; height: number; visible: number };

beforeEach(() => {
    box = { top: 0, height: 1000, visible: 200 };
    Object.defineProperty(HTMLDivElement.prototype, `scrollHeight`, { configurable: true, get: () => box.height });
    Object.defineProperty(HTMLDivElement.prototype, `clientHeight`, { configurable: true, get: () => box.visible });
    Object.defineProperty(HTMLDivElement.prototype, `scrollTop`, {
        configurable: true,
        get: () => box.top,
        set: (value: number) => {
            box.top = value;
        },
    });
});

afterEach(() => {
    for (const { app, host } of mounted.splice(0)) {
        app.unmount();
        host.remove();
    }
});

const mount = async (lines: string[]): Promise<{ host: HTMLElement; lines: ReturnType<typeof ref<string[]>> }> => {
    const held = ref(lines);
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(DeviceRunLog, { lines: held.value, running: true }) });
    app.component(`Icon`, IconStub);
    app.mount(host);
    mounted.push({ app, host });
    await nextTick();
    await nextTick();
    return { host, lines: held };
};

it(`opens at the newest line when the pane is drawn over a run already under way`, async () => {
    await mount([`#1 [internal] load build definition`, `#12 [builder 4/9] RUN pnpm install`]);
    expect(box.top).toBe(1000);
});

it(`follows the tail as the machine keeps printing`, async () => {
    const { lines } = await mount([`#1 [internal] load build definition`]);
    box.height = 2000;
    lines.value = [`#1 [internal] load build definition`, `#12 [builder 4/9] RUN pnpm install`];
    await nextTick();
    await nextTick();
    expect(box.top).toBe(2000);
});

// Reading back through a build is the other half of why the pane scrolls at all.
it(`leaves a reader who has scrolled up where they are`, async () => {
    const pane = await mount([`#1 [internal] load build definition`]);
    box.top = 10;
    // The scrolling pane, not the wrapper around it: a scroll event doesn't bubble, so the handler only runs where
    // the overflow is.
    pane.host.querySelector(`.overflow-auto`)!.dispatchEvent(new Event(`scroll`));
    box.height = 2000;
    pane.lines.value = [`#1 [internal] load build definition`, `#12 [builder 4/9] RUN pnpm install`];
    await nextTick();
    await nextTick();
    expect(box.top).toBe(10);
});
