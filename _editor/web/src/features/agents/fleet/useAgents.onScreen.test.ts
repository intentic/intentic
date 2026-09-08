// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same edges useAgents.test.ts cuts: importing the fleet store pulls in useChat and the app shell behind it.
vi.mock("../../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../../../app/analytics", () => ({ track: vi.fn() }));
vi.mock("../../sandbox/client/useSandbox", async () => {
    const { ref } = await import("vue");
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
vi.mock("../../sandbox/client/sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { nextTick } from "vue";
import { Conversation } from "../../chat/session/conversation";
import { useChat } from "../../chat/run/useChat";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { resetAgents } from "./useAgents";
import { setAgents } from "./useAgents-registry";

// A turn landing while its conversation is watched is not news; the card must not badge. Watching means this
// window is on screen with that chat focused, answered per window, including a floating chat's own copy.

// jsdom's `visibilityState` can't be set directly, so it's dressed by hand the way the browser would report it.
const show = (doc: Document, visible: boolean): void => {
    Object.defineProperty(doc, `visibilityState`, { value: visible ? `visible` : `hidden`, configurable: true });
    doc.dispatchEvent(new Event(`visibilitychange`));
};

// An agent opened once (seenAt) that worked since (updatedAt) with no turn in flight: the state this gate decides.
const worked = (id: string): AgentSummary => ({
    id,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 2_000,
    seenAt: 1_000,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
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

        // What the badge is for: a turn landing with nobody looking is news, whichever conversation was active.
        expect(sandboxJson).not.toHaveBeenCalledWith(...seen(`a2`));
    });
});
