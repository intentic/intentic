// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The same edges useAgents.test.ts cuts: importing the fleet store pulls useChat and the app shell behind it.
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../analytics", () => ({ track: vi.fn() }));
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { nextTick } from "vue";
import { Conversation } from "../chat/conversation";
import { useChat } from "../chat/useChat";
import { unwatchOnScreen, watchOnScreen } from "../onScreen";
import { sandboxJson } from "../sandbox/sandboxClient";
import { resetAgents, setAgents } from "./useAgents";

/* READING A CHAT IN A POP-OUT IS READING IT. A turn that lands while you are watching its conversation is not
 * news, so the card must not badge under your cursor — and the only thing that used to count as watching was
 * the app's TAB being visible. A popped-out chat is drawn by that tab's realm from a window of its own (see
 * composables/usePopout.ts), so a chat opened out there while the tab sat behind another one kept its "Updated"
 * badge until the user clicked back to the tab, where it then cleared on its own. */

// jsdom answers `visible` for the page's own document and `prerender` for a detached one, and neither can be
// set — so both windows are dressed by hand, the way the browser would report them.
const show = (doc: Document, visible: boolean): void => {
    Object.defineProperty(doc, `visibilityState`, { value: visible ? `visible` : `hidden`, configurable: true });
    doc.dispatchEvent(new Event(`visibilitychange`));
};

// An agent opened once (seenAt) that has worked since (updatedAt), with no turn of its own in flight: the
// "Updated" badge, and the one state this gate decides the fate of.
const worked = (id: string): AgentSummary => ({
    id,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 2_000,
    seenAt: 1_000,
    attention: { plan: false, question: false, permission: false, service: false, conflict: false },
});

const seen = (id: string): [string, RequestInit] => [`/agents/${id}/seen`, { method: `POST` }];

beforeEach(() => {
    resetAgents();
    vi.mocked(sandboxJson)
        .mockReset()
        .mockResolvedValue(undefined as never);
});

afterEach(() => show(document, true));

describe(`the unread badge across the app's windows`, () => {
    it(`clears for a chat read in a pop-out while the app's tab is behind another one`, async () => {
        const popout = document.implementation.createHTMLDocument(`popout`);
        show(popout, true);
        watchOnScreen(popout);
        show(document, false);
        useChat().conversations.value = [new Conversation(`a1`)];

        setAgents([worked(`a1`)], 1);
        await nextTick();

        expect(sandboxJson).toHaveBeenCalledWith(...seen(`a1`));
        unwatchOnScreen(popout);
    });

    it(`stands while every window the app renders into is away`, async () => {
        show(document, false);
        useChat().conversations.value = [new Conversation(`a2`)];

        setAgents([worked(`a2`)], 1);
        await nextTick();

        // What the badge is FOR: a turn that landed with nobody looking is news whichever conversation was
        // technically the active one.
        expect(sandboxJson).not.toHaveBeenCalledWith(...seen(`a2`));
    });
});
