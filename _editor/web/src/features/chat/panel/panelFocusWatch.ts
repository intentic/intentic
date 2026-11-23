import { effectScope, ref, watch } from "vue";
import { reportClient } from "../../../app/clientDiagnostics";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { drawsChat } from "../../../models/conversations/run/chatEcho";
import { focusTraceTail, traceFocus } from "../../../models/conversations/run/focusTrace";
import { active, activeId, conversations, panes, setConversations } from "../../../models/conversations/tabs/useChat-tabs";
import { describePanels, type DrawnPanel, type PanelRepair, panelsAgree, panelVerdict, repairsFor } from "./panelFocus";

// THE CHAT ON SCREEN IS THE CHAT THE BOARD RINGS. On 2026-11-23 the owner's board ringed each card they clicked while the
// docked chat beside it went on drawing another conversation, header and transcript alike, until the page was reloaded,
// several times that day. The tab store held its invariants on every path that writes it, and the demo did not
// reproduce it through hot updates, tucking, popping out, landing or opening a closed draft. So the trace that would have
// said why (focusTrace.ts) was lost with the reload. Hence this check, which needs neither the store nor Vue to be right:
// each ChatPanel stamps the chat it actually drew on its root (`data-chat-focus`, ChatPanel.vue), and a plain timer, run
// after every focus move whether or not the page still renders, reads those stamps back. When they disagree with the
// focus it reports `chat.focusStuck` with the trace and the panels it found, and repairs what it can (panelFocus.ts
// `repairsFor`). A repair that changes nothing is reported once more, as persisting, and not tried again for that focus.

// Long enough for any render a focus move starts to have landed, which a timer only fires after; short enough that the
// reader is still looking at the chat.
const SETTLE_MS = 1_500;

// The ChatPanels this window has mounted and not yet unmounted, by the id each stamps on its root. Registered in setup and
// let go before unmount, never on a template ref, whose writes wait for the post-render queue this check must not trust.
const live = new Set<string>();
let minted = 0;

/** A mounted panel's id and the release its unmount runs. */
interface LivePanel {
    readonly id: string;
    readonly release: () => void;
}

/** A new panel's id, live from now until its release runs (ChatPanel's onBeforeUnmount). */
export const livePanel = (): LivePanel => {
    minted += 1;
    const id = `chat-panel-${minted}`;
    live.add(id);
    return { id, release: () => live.delete(id) };
};

// Part of the docked panel's key (PoppablePanels.vue): bumped, the panel is unmounted and built again.
// allow(module-state): which build of this window's one docked panel stands, not a fact about any sandbox
export const panelEpoch = ref(0);

const onScreen = (element: HTMLElement): boolean => {
    if (!element.isConnected) {
        return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.right > 0 && box.left < window.innerWidth;
};

// Where a panel stands: the side panel's column, the quick bar, a popped-out window or Home, or parked off the page.
const placeOf = (element: HTMLElement): string => {
    if (element.closest(`.side-chat`) !== null) {
        return `side`;
    }
    if (element.closest(`.chat-quick-float`) !== null) {
        return `bar`;
    }
    return element.getBoundingClientRect().left < -10_000 ? `park` : `other`;
};

let timer: ReturnType<typeof setTimeout> | undefined;
// The focus the last repair was made for, and the one already reported as persisting: one repair and one second report
// per focus, so a panel nothing can repair is said once rather than every time its timer fires.
let repairedFor: string | undefined;
let persistedFor: string | undefined;

const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(checkPanelFocus, SETTLE_MS);
};

const ownedBy = (element: HTMLElement): boolean => live.has(element.dataset[`chatPanel`] ?? ``);

const readPanel = (element: HTMLElement): DrawnPanel => ({ focus: element.dataset[`chatFocus`], live: ownedBy(element), onScreen: onScreen(element) });

// Says what was found, where the owner's diagnostics are read (client.jsonl), with the trace of the moments before it.
const report = (focused: string, elements: readonly HTMLElement[], panels: readonly DrawnPanel[], repairs: readonly PanelRepair[], persisting: boolean): void => {
    const verdict = panelVerdict(focused, panels);
    const drawn = describePanels(panels);
    traceFocus(`panel-stuck`, { focused, drawn, repairs: repairs.join(`,`) || `none`, persisting });
    reportClient(
        `chat.focusStuck`,
        persisting ? `the chat panel still draws another chat than the focused one after its repair` : `the chat panel draws another chat than the focused one`,
        {
            fields: {
                focused,
                focusOpen: conversations.value.some((conversation) => conversation.conversationId === focused),
                resolved: active.value.conversationId,
                panes: panes.value.join(`,`),
                tabs: conversations.value.length,
                drawn,
                places: elements.map(placeOf).join(`,`),
                stale: verdict.stale,
                orphans: verdict.orphans,
                repairs: repairs.join(`,`),
                persisting,
                trace: focusTraceTail(40).join(`\n`).slice(-3_900),
            },
        },
    );
};

const repair = (focused: string, elements: readonly HTMLElement[], repairs: readonly PanelRepair[]): void => {
    for (const each of repairs) {
        if (each === `drop-orphans`) {
            for (const element of elements.filter((candidate) => !ownedBy(candidate))) {
                element.remove();
            }
        } else if (each === `refocus`) {
            // The focus names no open tab: the one writer falls back to an open chat, and the ring follows it there.
            setConversations(conversations.value, focused, `panel-refocus`);
        } else {
            panelEpoch.value += 1;
        }
    }
};

/** Reads every stamped panel back against the focus, reports a disagreement, and repairs it once. */
const checkPanelFocus = (): void => {
    timer = undefined;
    // A window not drawing the chat holds a shadow strip (chatEcho.ts), and no docked panel to compare.
    if (!drawsChat.value) {
        return;
    }
    const focused = activeId.value;
    const elements = [...document.querySelectorAll<HTMLElement>(`.chat-panel[data-chat-focus]`)];
    const panels = elements.map(readPanel);
    const verdict = panelVerdict(focused, panels);
    if (panelsAgree(verdict)) {
        repairedFor = undefined;
        persistedFor = undefined;
        return;
    }
    const persisting = repairedFor === focused;
    if (persisting && persistedFor === focused) {
        return;
    }
    const focusOpen = conversations.value.some((conversation) => conversation.conversationId === focused);
    const repairs = persisting ? [] : repairsFor(verdict, focusOpen);
    report(focused, elements, panels, repairs, persisting);
    if (persisting) {
        persistedFor = focused;
        return;
    }
    repairedFor = focused;
    repair(focused, elements, repairs);
    // Read again once the repair has had its render, to tell one that worked from one that did not.
    arm();
};

// Synchronous, so a focus move arms the check even while the render queue is what has stopped. Detached from whichever
// component first loads this module.
effectScope(true).run(() => {
    watch([activeId, conversations], arm, { flush: `sync` });
});

// One registry and one timer per window: a hot-reloaded rerun would split the panels' ids from the check reading them.
reloadOnHotUpdate(import.meta);
