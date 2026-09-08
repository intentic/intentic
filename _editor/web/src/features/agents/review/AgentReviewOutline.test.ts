// @vitest-environment jsdom
// The outline is a promise about a screen that hasn't arrived, so what it draws is the whole of it: the panel's two
// columns on a desktop, the list alone on a phone (whose diff is a full-screen takeover only a pick can open), and one
// announcement for the wait rather than one per bar.
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { uiLength } from "../../../shell/window/uiScale";

// The only stand-in: the form factor, which the kit reads off matchMedia (desktop under jsdom) and this suite needs
// both ways.
const mobile = ref(false);
vi.mock("@intentic/ui", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useDevice: () => ({ mobile }),
}));

const { default: AgentReviewOutline } = await import("./AgentReviewOutline.vue");
const { useLayout } = await import("../../../shell/window/useLayout");

let app: App | undefined;

const mount = async (label: string): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(AgentReviewOutline, { label }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await nextTick();
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    mobile.value = false;
});

it(`draws the list beside the diff at the reader's own list width, and says once what it is waiting for`, async () => {
    const el = await mount(`Reading this agent's changes…`);

    const status = el.querySelector(`[role="status"]`)!;
    expect(status.getAttribute(`aria-busy`)).toBe(`true`);
    expect(status.textContent).toContain(`Reading this agent's changes…`);
    // Exactly one region for the wait: the bars are decoration, and announcing each would say nothing sixty times.
    expect(el.querySelectorAll(`[role="status"]`)).toHaveLength(1);
    for (const bar of el.querySelectorAll(`.skeleton`)) {
        expect(bar.closest(`[aria-hidden="true"]`)).not.toBeNull();
    }

    // Both halves, and the list at the width the rows will land at, not a width they'd jump from.
    const list = el.querySelector(`aside`)!;
    expect(el.querySelector(`section`)).not.toBeNull();
    expect(list.style.width).toBe(uiLength(useLayout().reviewListWidth.value));
    // Rows to land in, more than one, at different lengths: a review is a list of paths, not a stack of bars.
    const widths = [...list.querySelectorAll(`.skeleton`)].map((bar) => bar.className);
    expect(new Set(widths).size).toBeGreaterThan(1);
});

it(`promises the list alone on a phone, where the diff is a screen only a pick opens`, async () => {
    mobile.value = true;
    const el = await mount(`Reading this agent's changes…`);

    const list = el.querySelector(`aside`)!;
    expect(list).not.toBeNull();
    expect(el.querySelector(`section`)).toBeNull();
    // No stored width either: the list is the whole screen here, so it takes the space rather than a column's share.
    expect(list.style.width).toBe(``);
});
