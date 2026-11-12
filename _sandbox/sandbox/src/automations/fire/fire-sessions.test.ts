import { ConversationIdSchema } from "@intentic/sandbox-contract/schemas/agent";
import { firedBy, mintConversationId } from "./fire-sessions.js";

const NOW = 1_800_000_000_000;

test("a short automation id is carried whole", () => {
    const id = mintConversationId("review", NOW);
    expect(id.startsWith("a-review-")).toBe(true);
    expect(firedBy("review", id)).toBe(true);
});

// The id is also the branch and the worktree folder, so a long automation id is cut, and its digest keeps two that share
// an opening apart.
test("a long automation id is cut short, and two sharing an opening still mint apart", () => {
    const web = mintConversationId("weekly-summary-for-web", NOW);
    const api = mintConversationId("weekly-summary-for-api", NOW);
    expect(web.length).toBeLessThanOrEqual(`a-`.length + 16 + 1 + 10);
    expect(ConversationIdSchema.safeParse(web).success).toBe(true);
    expect(firedBy("weekly-summary-for-web", web)).toBe(true);
    expect(firedBy("weekly-summary-for-api", web)).toBe(false);
    expect(firedBy("weekly-summary-for-web", api)).toBe(false);
});

test("a fire minted before ids were shortened still counts as its automation's own", () => {
    const automation = "nightly-dependency-updates-for-every-repo-in-the-workspace";
    const legacy = `a-${automation.slice(0, 40)}-${NOW.toString(36)}0`;
    expect(firedBy(automation, legacy)).toBe(true);
});

test("another automation whose id merely starts the same is not the one that fired", () => {
    expect(firedBy("review", mintConversationId("review-docs", NOW))).toBe(false);
});
