// @vitest-environment jsdom
// Asserts the invariant, not RailColumn's internals: the chat's rail (ChatTabs) and any other host's
// RailColumn are the same element at the same width, and dragging one drags both.
import { beforeAll, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { installUi } from "@intentic/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
import ChatTabs from "../features/chat/tabs/ChatTabs.vue";
import RailColumn from "./RailColumn.vue";
import { chatFullDock } from "../shell/window/dockSlots";
import { DEFAULT_RAIL_WIDTH, railWidth, setRailWidth } from "../features/agents/board/columnWidth";
import { queryClient } from "../lib/queryPersistence";
import { router } from "../router";

vi.hoisted(() => {
    // jsdom has no scrollIntoView; without this stub, focusing a card throws an unhandled rejection on mount.
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

// The chat's rail (ChatTabs) and the bare column another host mounts (RailColumn, as Subagents.vue does),
// side by side. Setting chatFullDock puts the chat panel on a wide surface, the one way a test can force ChatTabs into
// its rail form.
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
    // Width is a `calc` against --ui-scale, not a pixel count, so text-size scaling moves the column too.
    expect(chat.style.width).toBe(`calc(${DEFAULT_RAIL_WIDTH}px * var(--ui-scale))`);
    expect(other.style.width).toBe(chat.style.width);
    // Neither rail may size itself with a width class; both take their width from the same source.
    expect(chat.className).toBe(other.className);
    // Both carry the drag, asserted via `role="separator"`: ResizeSeam's contract, not its private class list.
    expect(chat.querySelector(`[role="separator"]`)).not.toBeNull();
    expect(other.querySelector(`[role="separator"]`)).not.toBeNull();
});

it(`moves both when either is dragged, and remembers it`, async () => {
    setRailWidth(400);
    await nextTick();
    expect(railOf(chatRail).style.width).toBe(`calc(400px * var(--ui-scale))`);
    expect(railOf(hostRail).style.width).toBe(`calc(400px * var(--ui-scale))`);

    // Clamped at both ends: the ceiling stops the drag, not the cards; the floor keeps titles from wrapping.
    setRailWidth(9000);
    expect(railWidth.value).toBe(480);
    setRailWidth(0);
    expect(railWidth.value).toBe(288);

    setRailWidth(360);
    // Stored, so tomorrow's window opens where this one was left: one key for the one column.
    expect(localStorage.getItem(`ui-chat-rail-width`)).toBe(`360`);
});
