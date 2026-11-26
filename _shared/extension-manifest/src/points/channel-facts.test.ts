import { CapabilityContributionSchema } from "./capabilities.js";

// What a card declares about its platform: a message limit, which targets its backend publishes to, what a publishing
// turn reads, where people's data goes, and that its status is its listener's report. Each is optional and describes.

const CARD = {
    id: "chat",
    kind: "cli",
    catalog: { name: "Chat", description: "A chat.", category: "communication" },
    fields: [{ key: "token", label: "Token", secret: true }],
    env: { CHAT_TOKEN: "${token}" },
    skill: "skills/chat/SKILL.md",
};

const issues = (declared: object): string[] =>
    CapabilityContributionSchema.safeParse({ ...CARD, ...declared }).error?.issues.map((issue) => issue.message) ?? [];

test("a card declares its platform's facts, each on its own", () => {
    expect(issues({})).toEqual([]);
    expect(issues({ channel: { messageLimit: 2_000, publish: { target: "^\\d{5,}$" }, posting: "Replies nest." } })).toEqual([]);
    expect(issues({ processors: [{ flow: "team-chat", operator: "Chat Inc.", region: "US", thirdCountry: true, hosts: ["chat.example"] }] })).toEqual([]);
    expect(issues({ processors: [{ flow: "email-imap", hostField: "host" }] })).toEqual([]);
    expect(issues({ status: { from: "listener", pairingSteps: "on the phone" } })).toEqual([]);
});

test("a target pattern must compile, a limit is a positive whole number, and a path names a flow the page words", () => {
    expect(issues({ channel: { publish: { target: "(" } } })).toEqual(["publish.target must be a regular expression that compiles"]);
    expect(issues({ channel: { messageLimit: 0 } })).toHaveLength(1);
    expect(issues({ channel: { messageLimit: 1.5 } })).toHaveLength(1);
    expect(issues({ processors: [{ flow: "carrier-pigeon" }] })).toHaveLength(1);
    expect(issues({ processors: [] })).toHaveLength(1);
    expect(issues({ status: { from: "probe" } })).toHaveLength(1);
});

test("a site the agent acts on in the browser declares its limit and its posting note the same way", () => {
    const site = { id: "forum", kind: "browser", catalog: CARD.catalog, fields: [], skill: "skills/forum/SKILL.md", channel: { messageLimit: 280, posting: "A reply nests." } };
    expect(CapabilityContributionSchema.safeParse(site).success).toBe(true);
});
