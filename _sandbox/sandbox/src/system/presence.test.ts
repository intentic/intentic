import type { PresenceUser } from "@intentic/sandbox-contract/events/system-events";
import { editorActiveAt, idleEverywhere, presentMembers, registerPresence, subscribePresence, updatePresence } from "./presence.js";

// The registry is module-level state shared across tests; each test registers under unique clientIds and
// unregisters what it created, so tests stay order-independent.

describe("presence registry", () => {
    test("subscribe delivers an immediate snapshot; register/unregister broadcast to prior subscribers", () => {
        const frames: PresenceUser[][] = [];
        const unsubscribe = subscribePresence((users) => frames.push(users));
        expect(frames).toHaveLength(1);

        const unregister = registerPresence("c1", { email: "a@x.com", name: "Ada", picture: "https://p/a.png", tier: "owner" });
        const joined = frames.at(-1)?.find((user) => user.clientId === "c1");
        expect(joined).toEqual({ clientId: "c1", email: "a@x.com", name: "Ada", picture: "https://p/a.png", tier: "owner", idle: false });

        unregister();
        expect(frames.at(-1)?.some((user) => user.clientId === "c1")).toBe(false);
        unsubscribe();
    });

    test("update full-replaces the activity fields and broadcasts", () => {
        const unregister = registerPresence("c2", { email: "a@x.com", tier: "collaborator" });
        const frames: PresenceUser[][] = [];
        const unsubscribe = subscribePresence((users) => frames.push(users));

        updatePresence({ email: "a@x.com" }, { clientId: "c2", idle: false, view: "workspace", path: "src/app.ts" });
        expect(frames.at(-1)?.find((user) => user.clientId === "c2")).toMatchObject({ view: "workspace", path: "src/app.ts" });

        // Absent fields clear: the tab left the file.
        updatePresence({ email: "a@x.com" }, { clientId: "c2", idle: true, view: "automations" });
        expect(frames.at(-1)?.find((user) => user.clientId === "c2")).toEqual({
            clientId: "c2",
            email: "a@x.com",
            tier: "collaborator",
            idle: true,
            view: "automations",
        });
        unsubscribe();
        unregister();
    });

    test("ignores an update for an unknown clientId or from a different member", () => {
        const unregister = registerPresence("c3", { email: "a@x.com", tier: "collaborator" });
        const frames: PresenceUser[][] = [];
        const unsubscribe = subscribePresence((users) => frames.push(users));

        updatePresence({ email: "a@x.com" }, { clientId: "ghost", idle: false, view: "workspace" });
        updatePresence({ email: "b@x.com" }, { clientId: "c3", idle: false, view: "workspace" });
        // Only the subscribe snapshot: neither bogus update broadcast, and c3 is untouched.
        expect(frames).toHaveLength(1);
        expect(frames.at(-1)?.find((user) => user.clientId === "c3")?.view).toBeUndefined();
        unsubscribe();
        unregister();
    });

    // What push reads to skip a member's own devices (push/push.ts): who has a tab in use, by lowercased address.
    test("present members are the ones with a tab in use, for as long as it stays connected", () => {
        const leave = [
            registerPresence("p1", { email: "Ada@X.com", tier: "owner" }),
            registerPresence("p2", { email: "bo@x.com", tier: "collaborator" }),
            registerPresence("p3", { email: "bo@x.com", tier: "collaborator" }),
            registerPresence("p4", { email: "cy@x.com", tier: "viewer" }),
        ];
        updatePresence({ email: "bo@x.com" }, { clientId: "p2", idle: true });
        updatePresence({ email: "cy@x.com" }, { clientId: "p4", idle: true });
        // Bo's second tab is still in use; Cy's only tab went idle.
        expect([...presentMembers()].toSorted()).toEqual(["ada@x.com", "bo@x.com"]);
        expect(idleEverywhere()).toBe(false);

        leave[0]?.();
        updatePresence({ email: "bo@x.com" }, { clientId: "p3", idle: true });
        expect([...presentMembers()]).toEqual([]);
        expect(idleEverywhere()).toBe(true);
        for (const unregister of leave.slice(1)) {
            unregister();
        }
    });

    // What the machine's sleep for memory reads through the work signal (quiet-watch.ts): connected is not used.
    describe("when a person was last at an editor", () => {
        const LATER = 9_999_999_999_999;
        // The stamp a transition leaves, between the clock before it and after it.
        const stampedDuring = (act: () => void): void => {
            const before = Date.now();
            act();
            const after = Date.now();
            expect(editorActiveAt(LATER)).toBeGreaterThanOrEqual(before);
            expect(editorActiveAt(LATER)).toBeLessThanOrEqual(after);
        };

        test("now while a connection has a person at it, a fresh one included, until its report says otherwise", () => {
            const leave = registerPresence("w1", { email: "a@x.com", tier: "owner" });
            expect(editorActiveAt(LATER)).toBe(LATER);
            updatePresence({ email: "a@x.com" }, { clientId: "w1", idle: false, view: "workspace" });
            expect(editorActiveAt(LATER)).toBe(LATER);
            // Off screen: the moment it went is the last activity, however long it stays connected.
            stampedDuring(() => updatePresence({ email: "a@x.com" }, { clientId: "w1", idle: true }));
            const offScreen = editorActiveAt(LATER);
            updatePresence({ email: "a@x.com" }, { clientId: "w1", idle: true, view: "automations" });
            expect(editorActiveAt(LATER)).toBe(offScreen);
            // Back on screen is a person again; on screen but untouched is not.
            updatePresence({ email: "a@x.com" }, { clientId: "w1", idle: false });
            expect(editorActiveAt(LATER)).toBe(LATER);
            stampedDuring(() => updatePresence({ email: "a@x.com" }, { clientId: "w1", idle: false, away: true }));
            leave();
        });

        test("one tab at work holds it whatever the others do; closing the last one at work is its last activity", () => {
            const leave = [registerPresence("w2", { email: "a@x.com", tier: "owner" }), registerPresence("w3", { email: "a@x.com", tier: "owner" })];
            updatePresence({ email: "a@x.com" }, { clientId: "w2", idle: true });
            expect(editorActiveAt(LATER)).toBe(LATER);
            stampedDuring(() => leave[1]?.());
            const closed = editorActiveAt(LATER);
            // Closing a tab nobody was at says nothing new.
            leave[0]?.();
            expect(editorActiveAt(LATER)).toBe(closed);
        });
    });
});
