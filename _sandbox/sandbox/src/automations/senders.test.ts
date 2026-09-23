import type { Automation } from "@intentic/sandbox-contract";
import { senderLane } from "./senders.js";

const automation = (extra: Partial<Automation> = {}): Automation => ({
    id: "guest",
    trigger: { kind: "listener", provider: "discord" },
    prompt: "answer",
    models: [{ provider: "claude", model: "claude-sonnet-4-6" }],
    enabled: true,
    ...extra,
});

const mark = { id: "u-mark", name: "Mark" };
const martha = { id: "u-martha", name: "Martha" };
const bob = { id: "u-bob", name: "Bob", groups: ["r-staff"] };

test("no sender rules admits everyone, wearing the automation's own persona", () => {
    expect(senderLane(automation({ actsAs: "customer-service" }), bob)).toEqual({ actsAs: "customer-service", requireApproval: false });
    expect(senderLane(automation(), bob)).toEqual({ actsAs: undefined, requireApproval: false });
});

test("the first rule naming the sender decides, and an absent actsAs is no persona at all", () => {
    const guest = automation({
        actsAs: "customer-service",
        senders: {
            rules: [{ ids: [mark.id] }, { ids: [martha.id, mark.id], actsAs: "customer-service" }],
            others: "ignore",
        },
    });
    // Mark is named by both; the first rule wins and gives him the unpinned agent, not the guest's persona.
    expect(senderLane(guest, mark)).toEqual({ actsAs: undefined, requireApproval: false });
    expect(senderLane(guest, martha)).toEqual({ actsAs: "customer-service", requireApproval: false });
});

test("a rule matches by group as well as by id, never by display name", () => {
    const guest = automation({ senders: { rules: [{ groups: ["r-staff"], actsAs: "staff" }], others: "ignore" } });
    expect(senderLane(guest, bob)).toEqual({ actsAs: "staff", requireApproval: false });
    // Same display name as a staff member, no matching id or group: a stranger.
    expect(senderLane(guest, { id: "u-impostor", name: "Bob" })).toBeUndefined();
});

test("everyone else gets what `others` says", () => {
    const rules = [{ ids: [mark.id] }];
    expect(senderLane(automation({ actsAs: "guest", senders: { rules, others: "ignore" } }), bob)).toBeUndefined();
    expect(senderLane(automation({ actsAs: "guest", senders: { rules, others: "hold" } }), bob)).toEqual({ actsAs: "guest", requireApproval: true });
    expect(senderLane(automation({ actsAs: "guest", senders: { rules, others: "allow" } }), bob)).toEqual({
        actsAs: "guest",
        requireApproval: false,
    });
});

test("a rule can hold its own people for a person", () => {
    const guest = automation({ senders: { rules: [{ ids: [martha.id], actsAs: "guest", requireApproval: true }], others: "allow" } });
    expect(senderLane(guest, martha)).toEqual({ actsAs: "guest", requireApproval: true });
});
