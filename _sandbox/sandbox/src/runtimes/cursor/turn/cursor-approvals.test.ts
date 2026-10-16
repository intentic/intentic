import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { parkedCards } from "../../../conversations/actor/parked-cards.js";
import { opt } from "../../../opt.js";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { builtInAsk, cursorOwner } from "./cursor-approvals.js";

// The person a `default`-mode Cursor turn puts each call to: a real parked card, answered as the composer answers one.

const cards = parkedCards(memoryFleet().conversations);
const EDIT = { toolName: "Write", displayName: "Edit file", title: "Edit this file?", path: "src/a.ts" };

const turnIn = (permissionMode: "default" | "bypassPermissions", restored?: { always: boolean }) => {
    const pushed: AgentEvent[] = [];
    const request = {
        spec: { prompt: "", cwd: WORKSPACE_ROOT, conversationId: "c-1" },
        policy: { permissionMode },
        hooks: { cards, ...opt("restoredGrant", restored === undefined ? undefined : () => restored) },
    };
    return { pushed, request };
};

// The id of the card the turn last raised, read off the frame it pushed.
const raised = (pushed: readonly AgentEvent[]): string => {
    const card = pushed.findLast((event) => event.kind === "permission");
    return card?.kind === "permission" ? card.requestId : "";
};

test("every mode but default runs every call without asking", () => {
    const { pushed, request } = turnIn("bypassPermissions");
    expect(cursorOwner(request, (event) => pushed.push(event), new AbortController().signal, () => true)).toBeUndefined();
});

test("a call waits on the card until the person answers, and a no carries their words back to the agent", async () => {
    const { pushed, request } = turnIn("default");
    const owner = cursorOwner(request, (event) => pushed.push(event), new AbortController().signal, () => true);
    const answer = owner?.approve(EDIT);
    await Promise.resolve();
    expect(pushed[0]).toMatchObject({ kind: "permission", toolName: "Write", path: "src/a.ts", alwaysLabel: "Don't ask again for Edit file" });
    cards.resolve({ kind: "permission", requestId: raised(pushed), decision: "deny", feedback: "Use the other file." });
    expect(await answer).toEqual({ allow: false, reason: "Use the other file." });
    expect(pushed.at(-1)).toMatchObject({ kind: "resolved" });
});

test("a don't-ask-again holds for the rest of the turn", async () => {
    const { pushed, request } = turnIn("default");
    const owner = cursorOwner(request, (event) => pushed.push(event), new AbortController().signal, () => true);
    const first = owner?.approve(EDIT);
    await Promise.resolve();
    cards.resolve({ kind: "permission", requestId: raised(pushed), decision: "always" });
    expect(await first).toEqual({ allow: true });
    const before = pushed.length;
    expect(await owner?.approve(EDIT)).toEqual({ allow: true });
    expect(pushed).toHaveLength(before);
});

test("the planning phase asks nobody, and a card answered before a restart is not asked again", async () => {
    const planning = turnIn("default");
    const asleep = cursorOwner(planning.request, (event) => planning.pushed.push(event), new AbortController().signal, () => false);
    expect(await asleep?.approve(EDIT)).toEqual({ allow: true });
    const resumed = turnIn("default", { always: false });
    const owner = cursorOwner(resumed.request, (event) => resumed.pushed.push(event), new AbortController().signal, () => true);
    expect(await owner?.approve(EDIT)).toEqual({ allow: true });
    expect([...planning.pushed, ...resumed.pushed]).toEqual([]);
});

test("a read is no card's business; a write, a deletion and a command are", () => {
    expect(builtInAsk("Read", { file_path: "/x" })).toBeUndefined();
    expect(builtInAsk("Grep", {})).toBeUndefined();
    expect(builtInAsk("Delete", { file_path: "/x" })).toMatchObject({ toolName: "Delete", path: "/x" });
    expect(builtInAsk("Shell", { command: "ls" })).toMatchObject({ program: { text: "ls", language: "bash" } });
});
