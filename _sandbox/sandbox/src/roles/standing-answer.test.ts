import type { ConversationGrant } from "@intentic/sandbox-contract/schemas/needs";
import { autoApproveOf, standingAnswers } from "./standing-answer.js";

// What answers a permission card without a person: "allow everything" for its own conversation's routine cards, the
// auto-approve mark for every card of the conversation marked and of each conversation it started, hard rules included.

const grant = (fields: Partial<ConversationGrant>): ConversationGrant => ({
    installs: false,
    secrets: [],
    everything: false,
    autoApprove: false,
    rules: [],
    updatedAt: 1,
    ...fields,
});

// parent → child → grandchild, and a loop in the records that must not hold a card.
const PARENTS = new Map([
    ["child", "parent"],
    ["grandchild", "child"],
    ["loop-a", "loop-b"],
    ["loop-b", "loop-a"],
]);
const parentOf = (id: string): string | undefined => PARENTS.get(id);

test("the mark reaches the conversation marked and every one it started, down any depth, and nothing above it", () => {
    const marked = (id: string): boolean => id === "child";
    expect(autoApproveOf(marked, parentOf, "child")).toBe("own");
    expect(autoApproveOf(marked, parentOf, "grandchild")).toBe("inherited");
    expect(autoApproveOf(marked, parentOf, "parent")).toBeUndefined();
    expect(autoApproveOf(marked, parentOf, "loop-a")).toBeUndefined();
});

test("allow everything answers its own conversation's routine cards only; the mark answers hard rules, and reaches down", () => {
    const grants = { parent: grant({ autoApprove: true }), other: grant({ everything: true }) };
    expect(standingAnswers(grants, parentOf, "other", false)).toBe(true);
    expect(standingAnswers(grants, parentOf, "other", true)).toBe(false);
    expect(standingAnswers(grants, parentOf, "parent", true)).toBe(true);
    expect(standingAnswers(grants, parentOf, "grandchild", true)).toBe(true);
    // Everything stays where it was given: a conversation the allowed one started still asks.
    expect(standingAnswers({ parent: grant({ everything: true }) }, parentOf, "child", false)).toBe(false);
    expect(standingAnswers({}, parentOf, "parent", false)).toBe(false);
});
