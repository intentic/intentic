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
import { sandboxJson } from "../sandbox/sandboxClient";
import { resetAgents, setAgents } from "./useAgents";

/* READING A CHAT IS READING IT. A turn that lands while you are watching its conversation is not news, so the
 * card must not badge under your cursor, and what counts as watching is this window being on screen with that
 * chat focused. Each window answers that for itself, the floating chat's window included, since it runs its own
 * copy of the app (composables/floating.ts). */

// jsdom answers `visible` for the page's own document and it cannot be set, so it is dressed by hand, the way
// the browser would report it.
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
    attention: { plan: false, question: false, permission: false, service: false, capability: false, conflict: false },
});

const seen = (id: string): [string, RequestInit] => [`/agents/${id}/seen`, { method: `POST` }];

beforeEach(() => {
    resetAgents();
    vi.mocked(sandboxJson)
        .mockReset()
        .mockResolvedValue(undefined as never);
});

afterEach(() => show(document, true));

describe(`the unread badge`, () => {
    it(`clears for the focused chat while this window is on screen`, async () => {
        show(document, true);
        useChat().conversations.value = [new Conversation(`a1`)];

        setAgents([worked(`a1`)], 1);
        await nextTick();

        expect(sandboxJson).toHaveBeenCalledWith(...seen(`a1`));
    });

    it(`stands while this window is away`, async () => {
        show(document, false);
        useChat().conversations.value = [new Conversation(`a2`)];

        setAgents([worked(`a2`)], 1);
        await nextTick();

        // What the badge is FOR: a turn that landed with nobody looking is news whichever conversation was
        // technically the active one.
        expect(sandboxJson).not.toHaveBeenCalledWith(...seen(`a2`));
    });
});
