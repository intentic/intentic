import type { Caller } from "../auth.js";
import { conversationReader, readsEverything, seesWholeFleet } from "./conversation-reader.js";
import type { Provenance } from "../fleet-scope.js";

// One guest's own conversation, one fenced to finance, one started by somebody unfenced; `pruned` is a conversation the
// registry no longer knows.
const conversations = new Map<string, Provenance>([
    ["guest-own", { startedBy: "gus@example.com", areas: ["finance"] }],
    ["finance", { startedBy: "fay@example.com", areas: ["finance"] }],
    ["everywhere", { startedBy: "owner@example.com" }],
]);
const ids = [...conversations.keys(), "pruned", undefined];
const readable = (caller: Caller | undefined): (string | undefined)[] => {
    const reads = conversationReader(caller, (id) => conversations.get(id));
    return ids.filter((id) => reads(id));
};
const member = (role: Caller["role"]): Caller => ({ email: `${role}@example.com`, role });

test("the owner, a maintainer and the owner's own tools read every conversation, and words tied to none", () => {
    expect(readable(undefined)).toEqual(ids);
    expect(readable(member("owner"))).toEqual(ids);
    expect(readable(member("maintainer"))).toEqual(ids);
    expect([undefined, member("owner"), member("maintainer")].every(readsEverything)).toBe(true);
});

test("anyone else reads only conversations the roster shows them, never words tied to none", () => {
    expect(readable(member("viewer"))).toEqual(["guest-own", "finance", "everywhere"]);
    expect(readable({ ...member("writer"), areas: ["finance"] })).toEqual(["guest-own", "finance"]);
    expect(readable({ email: "gus@example.com", role: "guest", areas: ["finance"] })).toEqual(["guest-own"]);
});

test("only an unfenced member who is not a guest sees the whole fleet", () => {
    expect(seesWholeFleet(member("viewer"))).toBe(true);
    expect(seesWholeFleet({ ...member("viewer"), areas: ["finance"] })).toBe(false);
    expect(seesWholeFleet({ email: "gus@example.com", role: "guest", areas: ["finance"] })).toBe(false);
});
