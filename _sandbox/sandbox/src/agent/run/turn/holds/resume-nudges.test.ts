import type { ConversationEvent } from "../../../../conversations/actor/conversation-decide.js";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import type { HeldTurn } from "./held-turn.js";
import { wakesResumePass } from "./resume-nudges.js";

// What wakes the pass is a hold it may now fire or a queue it may now let go, never its own acts on them. Read off real
// actors through `observe`, as the daemon wires it.
const watched = () => {
    const { conversations } = memoryFleet();
    const woke: ConversationEvent["kind"][] = [];
    conversations.observe((_id, event, before, after) => {
        if (wakesResumePass(event, before, after)) {
            woke.push(event.kind);
        }
    });
    return { conversations, woke };
};

const STOPPED: HeldTurn = { input: { conversationId: "c1", prompt: "go on" }, reason: "stopped", ran: true };
const turn = { conversationId: "c1", prompt: "later" };

describe("wakesResumePass", () => {
    it("wakes on a hold recorded, and not on the pass's own fire or drop of it", () => {
        const { conversations, woke } = watched();
        conversations.send("c1", { kind: "turn-held", held: STOPPED });
        const held = conversations.state("c1")?.resume.held;
        expect(held).toMatchObject({ reason: "stopped" });
        if (held === undefined) {
            return;
        }
        conversations.send("c1", { kind: "held-fired", ladder: true, judged: held });
        conversations.send("c1", { kind: "resume-dropped" });
        expect(woke).toEqual(["turn-held"]);
    });

    it("wakes on words booked or queued, and on a land let go", () => {
        const { conversations, woke } = watched();
        conversations.send("c1", { kind: "queue-scheduled", item: { id: "m1", voice: "person", queuedAt: 1, turn }, booking: { until: 10 } });
        conversations.send("c1", { kind: "land-leased" });
        conversations.send("c1", { kind: "land-released" });
        expect(woke).toEqual(["queue-scheduled", "land-released"]);
    });
});
