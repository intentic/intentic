import { homeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { unstubbed } from "@intentic/testing";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import type { Member } from "../../auth/auth.js";
import { homeOwnerLands } from "../../auth/operator.js";
import { homeOpening, refuseUnlessHome } from "./home-conversation.js";

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

// A home-only member (members.ts `agents: "home"`): their home is the one conversation they write into, and its work lands
// by itself exactly when they may land it (`landsHere`), so the person and the agent never answer differently.
describe("a home-only member", () => {
    const homeOnly = (lands: boolean): Pick<OrpcContext, "identity"> => {
        const identity = { email: "bo@example.com", role: "guest", agents: "home", methods: ["google"] } as const;
        return { identity: lands ? { ...identity, lands: true } : identity };
    };
    const BO = homeConversationId("bo@example.com");

    test("writes into their own home and nowhere else, starting nothing of their own", () => {
        expect(() => refuseUnlessHome(services(), homeOnly(false), BO)).not.toThrow();
        expect(() => refuseUnlessHome(services(), homeOnly(false), "swift-otter-k9m2")).toThrow(/your home conversation/);
        expect(() => refuseUnlessHome(services(), homeOnly(true), ADA)).toThrow(/your home conversation/);
        expect(() => refuseUnlessHome(services(), homeOnly(false), undefined)).toThrow(/your home conversation/);
    });

    test("nobody else is held to it", () => {
        expect(() => refuseUnlessHome(services(), as("ada@example.com", "collaborator"), "swift-otter-k9m2")).not.toThrow();
        expect(() => refuseUnlessHome(services(), {}, "swift-otter-k9m2")).not.toThrow();
    });

    test("their home lands by itself only when they may land it", () => {
        expect(homeOpening(services(), homeOnly(true), { conversationId: BO, isolated: true })).toEqual({ home: true, conversationAutoLand: true });
        expect(homeOpening(services(), homeOnly(false), { conversationId: BO, isolated: true })).toEqual({ home: true });
    });
});

// What a home's land reads at the land: its owner's authority as the roster says now.
describe("homeOwnerLands", () => {
    const roster = (members: readonly Member[], auth = true): Pick<Services, "auth" | "members" | "ownerEmail"> => ({
        auth: auth ? unstubbed<NonNullable<Services["auth"]>>("auth", {}) : undefined,
        ownerEmail: async () => "own@example.com",
        members: unstubbed<Services["members"]>("members", { list: async () => [...members] }),
    });

    test("the sandbox's owner, a maintainer and a home-only member granted it land; anyone else asks", async () => {
        const members: Member[] = [
            { email: "mai@example.com", role: "maintainer" },
            { email: "bo@example.com", role: "guest", agents: "home", lands: true },
            { email: "cy@example.com", role: "guest", agents: "home" },
            { email: "di@example.com", role: "collaborator" },
        ];
        const lands = async (email: string | undefined): Promise<boolean> => await homeOwnerLands(roster(members), email);
        expect(await lands("Own@Example.com")).toBe(true);
        expect(await lands("mai@example.com")).toBe(true);
        expect(await lands("bo@example.com")).toBe(true);
        expect(await lands("cy@example.com")).toBe(false);
        expect(await lands("di@example.com")).toBe(false);
        expect(await lands("gone@example.com")).toBe(false);
        expect(await lands(undefined)).toBe(false);
    });

    test("a loopback daemon's owner holds the whole sandbox", async () => {
        expect(await homeOwnerLands(roster([], false), undefined)).toBe(true);
    });
});
