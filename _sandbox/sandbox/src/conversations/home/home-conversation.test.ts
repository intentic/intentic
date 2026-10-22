import { homeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { unstubbed } from "@intentic/testing";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { homeOpening } from "./home-conversation.js";

// Who may speak into a home conversation, and what the turn opening it latches: the door's rules, apart from the route.

const as = (email: string, role: "owner" | "maintainer" | "collaborator"): Pick<OrpcContext, "identity"> => ({
    identity: { email, role, methods: ["google"] },
});

const services = (entries: Record<string, PersistedAgent> = {}, auth = true): Pick<Services, "auth" | "agents"> => ({
    auth: auth ? unstubbed<NonNullable<Services["auth"]>>("auth", {}) : undefined,
    agents: unstubbed<Services["agents"]>("agents", { entry: (id: string) => entries[id] }),
});

const ADA = homeConversationId("ada@example.com");

test("any other conversation passes untouched", () => {
    expect(homeOpening(services(), as("ada@example.com", "collaborator"), { conversationId: "swift-otter-k9m2" })).toEqual({});
});

test("the opening turn of a person's own home latches it, landing by itself only for one who may merge here", () => {
    expect(homeOpening(services(), as("Ada@Example.com", "maintainer"), { conversationId: ADA, isolated: true })).toEqual({
        home: true,
        conversationAutoLand: true,
    });
    expect(homeOpening(services(), as("ada@example.com", "collaborator"), { conversationId: ADA, isolated: true })).toEqual({ home: true });
});

test("a later turn latches nothing again", () => {
    const opened = services({ [ADA]: unstubbed<PersistedAgent>("entry", {}) });
    expect(homeOpening(opened, as("ada@example.com", "maintainer"), { conversationId: ADA, isolated: true })).toEqual({});
});

test("nobody speaks into somebody else's home, the sandbox's owner included", () => {
    expect(() => homeOpening(services(), as("own@example.com", "owner"), { conversationId: ADA, isolated: true })).toThrow(/not your home conversation/);
});

test("it opens on a copy of its own, never the shared tree", () => {
    expect(() => homeOpening(services(), as("ada@example.com", "maintainer"), { conversationId: ADA })).toThrow(/copy of its own/);
});

test("a program has none; the loopback owner has one", () => {
    expect(() => homeOpening(services(), {}, { conversationId: ADA, isolated: true })).toThrow(/a person's/);
    const loopback = homeConversationId("owner@loopback");
    expect(homeOpening(services({}, false), {}, { conversationId: loopback, isolated: true })).toEqual({ home: true, conversationAutoLand: true });
});
