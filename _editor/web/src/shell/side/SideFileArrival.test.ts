// The line over a peeked file that says how the reference reached it: one of several, with a way through the rest, or
// renamed since it was named.
import "@intentic/testing/dom";
import { installUi } from "@intentic/ui";
import { type App, createApp, h, nextTick } from "vue";
import type { FileArrival } from "../../workbench/side/sideFileInput";

const { default: SideFileArrival } = await import("./SideFileArrival.vue");
const { closeAllTabs, useSidePanel } = await import("../../workbench/side/sideTabs");
const { arrivalOf } = await import("../../workbench/side/sideFileInput");

const panel = useSidePanel();

let app: App | undefined;
const mount = async (props: { path: string; agent?: string; arrival: FileArrival }): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(SideFileArrival, props) });
    installUi(app);
    app.mount(host);
    await nextTick();
    return host;
};

beforeEach(() => {
    closeAllTabs();
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const MATCHES = [`a/pages/index.md`, `b/pages/index.md`, `c/d/pages/index.md`];

it(`says which of the matches is shown, and steps to the next in the tab's place, keeping the list`, async () => {
    const host = await mount({ path: `b/pages/index.md`, agent: `c-1`, arrival: { asked: `pages/index.md`, matches: MATCHES } });
    expect(host.textContent).toContain(`pages/index.md`);
    expect(host.textContent).toMatch(/2\D+3/);
    const [, next] = host.querySelectorAll<HTMLButtonElement>(`button`);
    next?.click();
    await nextTick();
    expect(panel.tabs.value.map((tab) => tab.input)).toEqual([{ path: `c/d/pages/index.md`, agent: `c-1` }]);
    expect(arrivalOf({ path: `c/d/pages/index.md`, agent: `c-1` })?.matches).toEqual(MATCHES);
});

it(`wraps from the first match back to the last`, async () => {
    const host = await mount({ path: `a/pages/index.md`, arrival: { asked: `pages/index.md`, matches: MATCHES } });
    host.querySelector<HTMLButtonElement>(`button`)?.click();
    await nextTick();
    expect(panel.tabs.value.map((tab) => tab.input)).toEqual([{ path: `c/d/pages/index.md` }]);
});

it(`names the file a renamed one was asked by`, async () => {
    const host = await mount({
        path: `_os/installer/bib-config.toml`,
        arrival: { asked: `installer/config.toml`, renamedFrom: `_os/installer/config.toml` },
    });
    expect(host.textContent).toContain(`config.toml`);
    expect(host.querySelectorAll(`button`)).toHaveLength(0);
});
