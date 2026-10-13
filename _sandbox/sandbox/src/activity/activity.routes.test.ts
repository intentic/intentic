import type { ActivityEvent, ActivityStatus } from "@intentic/sandbox-contract";
import type { Caller } from "../auth/auth.js";
import type { Provenance } from "../auth/fleet-scope.js";
import { activityScope, resolveConnections } from "./activity.routes.js";

type Conn = ActivityStatus["connections"][number];
const conn = (gateway: Conn["gateway"], capabilityId = "discord"): Conn => ({ capabilityId, provider: "discord", gateway });
const ERROR = "Discord rejected the bot token: check the capability's botToken";

// idle = no enabled listener automation: the gateway is up but deliberately not connecting, so every card reads
// "idle" and no login error is surfaced (there was no login attempt to fail).
test("idle overrides every pushed gateway state and drops lastError", () => {
    expect(resolveConnections([conn("disconnected"), conn("ready", "d2")], true, ERROR)).toEqual([
        { capabilityId: "discord", provider: "discord", gateway: "idle" },
        { capabilityId: "d2", provider: "discord", gateway: "idle" },
    ]);
});

// With an enabled automation, only a genuinely-down connection carries the error; a connected/connecting card
// must not inherit a stale system-error from the recent-log scan.
test("lastError rides only a disconnected connection", () => {
    const resolved = resolveConnections([conn("disconnected"), conn("ready", "d2"), conn("connecting", "d3")], false, ERROR);
    expect(resolved[0]).toEqual({ capabilityId: "discord", provider: "discord", gateway: "disconnected", lastError: ERROR });
    expect(resolved[1]).toEqual({ capabilityId: "d2", provider: "discord", gateway: "ready" });
    expect(resolved[2]).toEqual({ capabilityId: "d3", provider: "discord", gateway: "connecting" });
});

// A down connection with nothing in the error log stays a bare "Not listening": no lastError key at all.
test("a disconnected connection with no recorded error carries no lastError", () => {
    const resolved = resolveConnections([conn("disconnected")], false, undefined);
    expect(resolved).toEqual([{ capabilityId: "discord", provider: "discord", gateway: "disconnected" }]);
    // Absent, not present-and-undefined: the browser renders the key's presence.
    expect(resolved.flatMap((row) => Object.keys(row))).not.toContain("lastError");
});

// Who reads which prompts: the conversations below are one guest's own, one fenced to the finance area, and one started
// by somebody unfenced. A prompt belongs to the conversation that carried it, and an entry tied to none is the managers'.
describe("activityScope", () => {
    const conversations = new Map<string, Provenance>([
        ["guest-own", { startedBy: "gus@example.com", areas: ["finance"] }],
        ["finance", { startedBy: "fay@example.com", areas: ["finance"] }],
        ["everywhere", { startedBy: "owner@example.com" }],
    ]);
    const events: ActivityEvent[] = [
        ...[...conversations.keys()].map((conversationId, index) => ({ id: conversationId, at: index, direction: "in" as const, type: "message.received", conversationId })),
        { id: "gone", at: 10, direction: "in", type: "message.received", conversationId: "pruned" },
        { id: "bot", at: 11, direction: "system", type: "gateway.login_failed", provider: "discord" },
    ];
    const read = (caller: Caller | undefined): string[] => {
        const shows = activityScope(caller, (id) => conversations.get(id));
        return events.filter((event) => shows === undefined || shows(event)).map((event) => event.id);
    };
    const member = (role: Caller["role"]): Caller => ({ email: `${role}@example.com`, role });

    test("the owner, a maintainer and the owner's own tools read every entry", () => {
        const all = events.map((event) => event.id);
        expect(read(undefined)).toEqual(all);
        expect(read(member("owner"))).toEqual(all);
        expect(read(member("maintainer"))).toEqual(all);
    });

    test("an unfenced viewer reads the conversations it may see, never entries tied to none", () => {
        expect(read(member("viewer"))).toEqual(["guest-own", "finance", "everywhere"]);
    });

    test("a member fenced to an area reads only that area's conversations", () => {
        expect(read({ ...member("collaborator"), areas: ["finance"] })).toEqual(["guest-own", "finance"]);
    });

    test("a guest reads only its own conversations", () => {
        expect(read({ email: "gus@example.com", role: "guest", areas: ["finance"] })).toEqual(["guest-own"]);
    });
});
