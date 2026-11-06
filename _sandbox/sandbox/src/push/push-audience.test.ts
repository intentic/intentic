import { childActor } from "../auth/principal.js";
import type { PersistedAgent } from "../conversations/registry/agents-store.js";
import { conversationEntry } from "../conversations/registry/agents-store.testing.js";
import { askedAudience, automationAudience, finishedAudience, OPERATORS } from "./push-audience.js";

// A conversation's news is for the people who took part in it, as much of it as each asked for; a subagent's ending is
// the conversation it reports to's to judge; a card down a family waits on the people at its top.

const ADA = { email: "ada@example.com", since: 1 };
const entries = new Map<string, PersistedAgent>([
    ["home-1", conversationEntry({ id: "home-1", identity: { home: true, startedBy: "ada@example.com" }, social: { owner: ADA, reactions: [] } })],
    ["sub-a", conversationEntry({ id: "sub-a", identity: { startedBy: childActor("home-1") }, social: { owner: ADA, reactions: [] } })],
    // A review the home opened on sub-a's work hangs under sub-a and reports to the home.
    ["sub-r", conversationEntry({ id: "sub-r", identity: { startedBy: childActor("sub-a"), fresh: { of: "sub-a", kind: "review", at: 1, by: "home-1" } } })],
    [
        "chat",
        conversationEntry({
            id: "chat",
            identity: { startedBy: "bob@example.com" },
            social: {
                owner: { email: "bob@example.com", since: 1 },
                reactions: [{ emoji: "👀", email: "dan@example.com", at: 2 }],
                participants: [
                    { email: "cy@example.com", since: 2, via: "prompt" },
                    { email: "eve@example.com", since: 3, via: "answer" },
                ],
                notify: [
                    { email: "eve@example.com", level: "asks", at: 4 },
                    { email: "bob@example.com", level: "none", at: 4 },
                    { email: "fay@example.com", level: "all", at: 5 },
                ],
            },
        }),
    ],
    ["chat-child", conversationEntry({ id: "chat-child", identity: { startedBy: childActor("chat") }, social: { owner: { email: "bob@example.com", since: 1 }, reactions: [] } })],
    ["program", conversationEntry({ id: "program", identity: { startedBy: "token:deploy-bot" } })],
    ["channel", conversationEntry({ id: "channel", identity: { origin: { automationId: "chat-bridge", provider: "discord", channelId: "c1" } }, social: { owner: ADA, reactions: [] } })],
]);
const entryOf = (id: string) => entries.get(id);
const emailsOf = (audience: ReturnType<typeof askedAudience> | undefined) => (audience?.kind === "people" ? audience.emails : audience?.kind);

test("a finished turn is news to who took part and wants all of it; never to a subagent's people, a channel's, or a program's", () => {
    expect(emailsOf(finishedAudience(entryOf, "home-1"))).toEqual(["ada@example.com"]);
    // Bob turned it off, Eve asked only for what waits on her, Fay follows it without having taken part, a reaction is no part.
    expect(emailsOf(finishedAudience(entryOf, "chat"))).toEqual(["cy@example.com", "fay@example.com"]);
    expect(finishedAudience(entryOf, "sub-a")).toBeUndefined();
    expect(finishedAudience(entryOf, "sub-r")).toBeUndefined();
    expect(finishedAudience(entryOf, "channel")).toBeUndefined();
    expect(finishedAudience(entryOf, "program")).toBeUndefined();
    expect(finishedAudience(entryOf, "gone")).toBeUndefined();
});

test("a finished turn's audience names the conversation it is about, so the sender can drop whoever it is hidden from", () => {
    expect(finishedAudience(entryOf, "chat")).toMatchObject({ about: { startedBy: "bob@example.com", owner: { email: "bob@example.com" } } });
});

test("a card waits on the people at the top of its family who did not turn it off, and on the operators when that is nobody", () => {
    expect(emailsOf(askedAudience(entryOf, "home-1"))).toEqual(["ada@example.com"]);
    expect(emailsOf(askedAudience(entryOf, "sub-r"))).toEqual(["ada@example.com"]);
    expect(emailsOf(askedAudience(entryOf, "chat-child"))).toEqual(["cy@example.com", "eve@example.com", "fay@example.com"]);
    expect(askedAudience(entryOf, "program")).toMatchObject({ kind: "operators", about: { startedBy: "token:deploy-bot" } });
});

test("a credential card waits on the people named on it, whoever took part", () => {
    expect(emailsOf(askedAudience(entryOf, "chat", ["Max@Example.com"]))).toEqual(["max@example.com"]);
});

test("an automation's notices go to whoever made it: a person, the people of the conversation that proposed it, else the operators", () => {
    expect(emailsOf(automationAudience(entryOf, "Ada@Example.com"))).toEqual(["ada@example.com"]);
    expect(emailsOf(automationAudience(entryOf, childActor("chat")))).toEqual(["cy@example.com", "fay@example.com"]);
    expect(automationAudience(entryOf, childActor("program"))).toEqual(OPERATORS);
    expect(automationAudience(entryOf, childActor("gone"))).toEqual(OPERATORS);
    expect(automationAudience(entryOf, undefined)).toEqual(OPERATORS);
});
