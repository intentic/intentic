import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// Same edges useAgents.test.ts cuts: importing the fleet store pulls in useChat and the app shell behind it.
mock.module("../../../router", () => ({ router: { push: mock() } }));
mock.module("../../../app/analytics", () => ({ track: mock() }));
mock.module("../../sandbox/client/useSandbox", () => {
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
// The read marker, the one daemon write this gate decides.
const seen = mock();
mock.module("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agents: { seen } }) }));
mock.module("../../sandbox/client/sandboxClient", () => ({ sandboxJson: mock(), sandboxRequest: mock() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { nextTick, ref } from "vue";
import { Conversation } from "../../chat/session/conversation";
import { useChat } from "../../chat/run/useChat";
import { useAgents } from "./useAgents";
import { setAgents } from "./useAgents-registry";

// The fleet store itself, whose watch is the gate under test.
const { fleet } = useAgents();

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

beforeEach(() => {
    resetSandboxScope();
    seen.mockReset().mockImplementation(async ({ id }: { id: string }) => worked(id));
});

afterEach(() => show(document, true));

describe(`the unread badge`, () => {
    it(`clears for the focused chat while this window is on screen`, async () => {
        show(document, true);
        useChat().conversations.value = [new Conversation(`a1`)];

        setAgents([worked(`a1`)], 1);
        await nextTick();

        expect(fleet.value.map((agent) => agent.id)).toEqual([`a1`]);
        expect(seen).toHaveBeenCalledWith({ id: `a1` });
    });

    it(`stands while this window is away`, async () => {
        show(document, false);
        useChat().conversations.value = [new Conversation(`a2`)];

        setAgents([worked(`a2`)], 1);
        await nextTick();

        // What the badge is for: a turn landing with nobody looking is news, whichever conversation was active.
        expect(seen).not.toHaveBeenCalledWith({ id: `a2` });
    });
});
