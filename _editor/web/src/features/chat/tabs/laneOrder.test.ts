import "@intentic/testing/dom";
import type { OpenChat } from "./cardView";
import { type ChatLanes, steadyLanes } from "./laneOrder";

// While the reader's pointer is on the list, a card must not move under it: opening a chat re-sorted the list, and the
// next press on the same spot opened a different chat.

// A row reduced to the one field these rules read.
const row = (id: string): OpenChat =>
    // SAFETY: steadyLanes reads nothing of a row but its conversation's id.
    ({ conversation: { conversationId: id }, agent: undefined }) as unknown as OpenChat;

const lanes = (attention: string[], active: string[] = [], finished: string[] = []): ChatLanes => ({
    attention: attention.map(row),
    active: active.map(row),
    finished: finished.map(row),
});

const ids = (drawn: ChatLanes): Record<keyof ChatLanes, string[]> => ({
    attention: drawn.attention.map((entry) => entry.conversation.conversationId),
    active: drawn.active.map((entry) => entry.conversation.conversationId),
    finished: drawn.finished.map((entry) => entry.conversation.conversationId),
});

test(`with nothing held the fresh order stands`, () => {
    const fresh = lanes([`b`, `a`]);
    expect(steadyLanes(fresh, undefined)).toBe(fresh);
});

test(`a held lane keeps the order it was drawn in, however the fresh one sorts`, () => {
    expect(ids(steadyLanes(lanes([`b`, `a`, `c`]), lanes([`a`, `b`, `c`])))).toEqual({ attention: [`a`, `b`, `c`], active: [], finished: [] });
});

test(`a chat that left a lane goes, and one that joined it waits at the foot`, () => {
    const held = lanes([`a`, `b`], [`c`]);
    const fresh = lanes([`c`, `a`], [`b`]);
    expect(ids(steadyLanes(fresh, held))).toEqual({ attention: [`a`, `c`], active: [`b`], finished: [] });
});
