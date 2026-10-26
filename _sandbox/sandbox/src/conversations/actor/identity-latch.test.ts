import { conversationEntry } from "../registry/agents-store.testing.js";
import type { BeginTurn } from "./conversation-decide.js";
import { servicesOfConversation } from "./identity-latch.js";

// The services a conversation acts for only ever grow: the turn's own, what it held, and the speaking conversation's,
// since what it may reach is what every one of them may (access/principal-chain.ts).

const held = (services?: readonly string[]) => conversationEntry({ identity: services === undefined ? {} : { services: [...services] } });

const turn = (extra: Partial<BeginTurn> = {}): BeginTurn => ({ conversationId: "c1", prompt: "go", profile: {}, isolated: true, ...extra });

test("a turn running as a service adds it, and keeps every service held before", () => {
    expect(servicesOfConversation(held(["bot"]), turn({ runAs: "staff" }), () => undefined)).toEqual({ services: ["bot", "staff"] });
    expect(servicesOfConversation(held(["bot"]), turn(), () => undefined)).toEqual({ services: ["bot"] });
});

test("a child spoken into by its parent brings the parent's services along", () => {
    const parent = held(["bot"]);
    expect(servicesOfConversation(held(), turn({ startedBy: "agent:p1" }), (id) => (id === "p1" ? parent : undefined))).toEqual({ services: ["bot"] });
});

test("a conversation that never ran as a service records none", () => {
    expect(servicesOfConversation(held(), turn(), () => undefined)).toEqual({});
});
