import { IN_MEMORY } from "@intentic/base/sqlite";
import { homeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { beginTurn } from "../actor/conversation-actors.testing.js";
import { conversationEntry } from "../registry/agents-store.testing.js";
import { fleetStoreOver, memoryFleet } from "../registry/agents-registry.testing.js";
import { openConversationsDb } from "../../store/conversations-db.js";
import { opt } from "../../opt.js";

const ADA = homeConversationId("ada@example.com");
const OWNER = { email: "ada@example.com", name: "Ada Lovelace" };

test.each([
    { owner: OWNER, title: "Home · Ada Lovelace" },
    { owner: { email: OWNER.email, name: "  Ada Lovelace  " }, title: "Home · Ada Lovelace" },
    { owner: { email: OWNER.email }, title: "Home · ada@example.com" },
    { owner: { email: OWNER.email, name: "  " }, title: "Home · ada@example.com" },
    { owner: undefined, title: "Home" },
])("a home opens as $title, regardless of the prompt or supplied title", async ({ owner, title }) => {
    const { agents, conversations } = memoryFleet();
    await agents.init();
    await beginTurn(conversations, {
        conversationId: ADA,
        prompt: "Are you there?",
        title: "Presence",
        titleSource: "model",
        profile: { agent: "claude", harness: "native" },
        isolated: true,
        home: true,
        ...opt("owner", owner),
    }, 100);
    expect(agents.get(ADA)?.title).toBe(title);
    expect(agents.entry(ADA)?.social.title).toEqual({ text: title, source: "derived" });
});

test("a home's name survives model titles, plan headings, later topics and a restart; a person can rename it", async () => {
    const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
    const { agents, conversations } = memoryFleet(store);
    await agents.init();
    const opening = {
        conversationId: ADA,
        prompt: "Are you there?",
        profile: { agent: "claude", harness: "native" } as const,
        isolated: true,
        home: true as const,
        owner: OWNER,
    };
    await beginTurn(conversations, opening, 100);
    await agents.setTitle(ADA, "Presence", "model", "inquire");
    await conversations.send(ADA, { kind: "frame", frame: { kind: "plan", requestId: "plan-parser", text: "# Ship the parser\n1. Start" } }).settled;
    expect(agents.get(ADA)?.title).toBe("Home · Ada Lovelace");
    expect(agents.get(ADA)?.titleAction).toBeUndefined();
    await conversations.send(ADA, { kind: "settle" }, 200).settled;
    await beginTurn(conversations, { ...opening, prompt: "Fix the deployment", title: "Deployment" }, 300);
    expect(agents.get(ADA)?.title).toBe("Home · Ada Lovelace");
    await agents.setTitle(ADA, "My workshop", "user");
    await agents.setTitle(ADA, "Deployment", "model", "fix");
    await conversations.send(ADA, { kind: "frame", frame: { kind: "plan", requestId: "plan-deploy", text: "# Deploy\n1. Start" } }).settled;
    expect(agents.get(ADA)?.title).toBe("My workshop");
    await conversations.send(ADA, { kind: "settle" }, 400).settled;
    const restarted = memoryFleet(store).agents;
    await restarted.init();
    expect(restarted.get(ADA)?.title).toBe("My workshop");
    expect(restarted.entry(ADA)?.social.title).toEqual({ text: "My workshop", source: "user" });
});

test.each([undefined, "derived", "model", "plan", "user"] as const)("loading an older home with a %s title corrects only automatic names", async (source) => {
    const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
    const title = source === undefined ? {} : { title: { text: "Presence", source, action: "inquire" } };
    store.agents.save([
        conversationEntry({ id: ADA, identity: { home: true }, social: { ...title, owner: { ...OWNER, since: 10 }, reactions: [] }, updatedAt: 20 }),
        conversationEntry({ id: "ordinary", social: { ...title, reactions: [] } }),
    ]);
    const { agents } = memoryFleet(store);
    await agents.init();
    expect(agents.entry(ADA)?.social.title).toEqual(source === "user"
        ? { text: "Presence", source, action: "inquire" }
        : { text: "Home · Ada Lovelace", source: "derived" });
    expect(agents.get(ADA)?.title).toBe(source === "user" ? "Presence" : "Home · Ada Lovelace");
    expect(agents.get(ADA)?.updatedAt).toBe(20);
    expect(agents.entry("ordinary")?.social.title).toEqual(title.title);
});
