// @vitest-environment jsdom
//
// ONE COLUMN, TWO SURFACES. The chat's list of open conversations (ChatTabs in its rail form, out in a floating
// window or filling the /chat area) and the agents this sandbox's agents started (pages/Subagents.vue) draw the
// same cards on the same lanes, and used to draw them in two hand-rolled columns: one fixed at 288px, the other
// resizable from 320, padded a half-step apart. Two lists of one kind of thing that look like two components is
// the failure this file exists to catch, so what it holds is not RailColumn's internals but the INVARIANT: the
// chat's rail and a rail any other host mounts are the same element at the same width, and dragging either is
// dragging THE rail.
import { beforeAll, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { installUi } from "@intentic/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
// Statically imported for chatTabsMenu.test.ts's reason: this graph is the whole app's, and compiling it cold
// inside a hook outlasts vitest's hookTimeout, where the same work at import time is simply the file's load.
import ChatTabs from "../chat/ChatTabs.vue";
import RailColumn from "./RailColumn.vue";
import { chatFullDock } from "../shell/dockSlots";
import { DEFAULT_RAIL_WIDTH, railWidth, setRailWidth } from "../composables/rail";
import { queryClient } from "../composables/queryPersistence";
import { router } from "../router";

vi.hoisted(() => {
    // The list scrolls its focused card back into view on every focus write, and jsdom implements no
    // scrollIntoView: without this stub the first mount ends in an unhandled rejection.
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
});

const mount = (component: Parameters<typeof h>[0]): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.appendChild(host);
    const app = createApp({ render: () => h(component) });
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    installUi(app);
    app.mount(host);
    return host;
};

// The two rails, side by side in one document: the chat's, and the bare column every other host puts its own
// list in (what Subagents.vue mounts). The chat panel is on a WIDE surface here, which is the whole of what
// turns its bar into a rail (chatSurface.chatWide) — the /chat area publishing its slot is one of the two ways
// that happens, and the one a test can stand up without a second window.
let chatRail: HTMLElement;
let hostRail: HTMLElement;
beforeAll(async () => {
    chatFullDock.value = document.createElement(`div`);
    chatRail = mount(ChatTabs);
    hostRail = mount(RailColumn);
    await nextTick();
});

const railOf = (host: HTMLElement): HTMLElement => {
    const rail = host.querySelector<HTMLElement>(`aside`);
    expect(rail, `every rail is a RailColumn <aside>`).not.toBeNull();
    return rail!;
};

it(`draws both rails as the same column, at the same width`, () => {
    const chat = railOf(chatRail);
    const other = railOf(hostRail);
    // The width is a `calc` against --ui-scale rather than a pixel count, so a reader's text size moves the
    // column that holds their card titles (uiScale.ts).
    expect(chat.style.width).toBe(`calc(${DEFAULT_RAIL_WIDTH}px * var(--ui-scale))`);
    expect(other.style.width).toBe(chat.style.width);
    // Neither may size itself: a Tailwind width class here is exactly how the two came apart before.
    expect(chat.className).toBe(other.className);
    // And both carry the drag: a rail that cannot be widened is the one whose reader has to live with it.
    expect(chat.querySelector(`.rail-resize`)).not.toBeNull();
    expect(other.querySelector(`.rail-resize`)).not.toBeNull();
});

it(`moves both when either is dragged, and remembers it`, async () => {
    setRailWidth(400);
    await nextTick();
    expect(railOf(chatRail).style.width).toBe(`calc(400px * var(--ui-scale))`);
    expect(railOf(hostRail).style.width).toBe(`calc(400px * var(--ui-scale))`);

    // Past the ceiling the drag stops rather than the cards do, and the floor is the width the same list is
    // guaranteed in the docked sheet: below it a card's title wraps to three lines and its meta row breaks up.
    setRailWidth(9000);
    expect(railWidth.value).toBe(480);
    setRailWidth(0);
    expect(railWidth.value).toBe(288);

    setRailWidth(360);
    // Stored, so tomorrow's window opens where this one was left: one key for the one column.
    expect(localStorage.getItem(`ui-chat-rail-width`)).toBe(`360`);
});
