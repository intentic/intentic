// The outline holds the frame of a screen that hasn't arrived, and nothing it would have to guess: the panel's two
// columns on a desktop, the list alone on a phone (whose diff is a full-screen takeover only a pick can open), and one
// line saying what the wait is for.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { uiLength } from "../../../shell/window/uiScale";
import * as actualUi from "@intentic/ui";

// The only stand-in: the form factor, which the kit reads off matchMedia (desktop under jsdom) and this suite needs
// both ways.
const mobile = ref(false);
jest.mock("@intentic/ui", () => ({
    ...actualUi,
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

it(`holds the list beside the diff at the reader's own list width, and says once, in words, what it is waiting for`, async () => {
    const el = await mount(`Reading this agent's changes…`);

    const status = el.querySelector(`[role="status"]`)!;
    expect(status.getAttribute(`aria-busy`)).toBe(`true`);
    expect(status.textContent).toContain(`Reading this agent's changes…`);
    expect(el.querySelectorAll(`[role="status"]`)).toHaveLength(1);
    // Read, not only announced: with no bars standing in for the content, the line is the whole of what the wait says.
    expect(status.closest(`[aria-hidden="true"]`)).toBeNull();
    expect(status.closest(`.sr-only`)).toBeNull();

    // Both columns, and the list at the width the rows will land at, not a width they'd jump from.
    const list = el.querySelector(`aside`)!;
    expect(el.querySelector(`section`)).not.toBeNull();
    expect(list.style.width).toBe(uiLength(useLayout().reviewListWidth.value));
    // No guessed rows or code lines: every review is its own, so the frame is all a wait can honestly hold.
    expect(el.querySelectorAll(`.skeleton`)).toHaveLength(0);
    expect(el.querySelectorAll(`*`).length).toBeLessThan(12);
});

it(`holds the list alone on a phone, where the diff is a screen only a pick opens`, async () => {
    mobile.value = true;
    const el = await mount(`Reading this agent's changes…`);

    const list = el.querySelector(`aside`)!;
    expect(list).not.toBeNull();
    expect(el.querySelector(`section`)).toBeNull();
    // No stored width either: the list is the whole screen here, so it takes the space rather than a column's share.
    expect(list.style.width).toBe(``);
});
