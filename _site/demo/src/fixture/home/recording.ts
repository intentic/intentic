import { homeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { PERSONAL } from "./personal";
import { RESEARCH } from "./research";
import type { HomeSandbox, RecordedSandbox } from "./sandboxes";
import { SHOP } from "./shop";
import type { HomeStory } from "./story";

// The /home recording uses the real chat, sandbox rail and plan-limit components.
export const homeAgent = (email: string, now: number): AgentSummary => ({
    id: homeConversationId(email),
    title: `Home`,
    sessionId: `ses_demo_home`,
    provider: `claude`,
    harness: `claude-code`,
    model: `claude-opus-5`,
    effort: `high`,
    account: `acc_claude_demo`,
    status: `idle`,
    branch: `agent/${homeConversationId(email)}`,
    base: `4f1c8ab`,
    turns: 2,
    updatedAt: now - 60_000,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
});

// Each sandbox's home conversation: what was said before, and the turn it plays when first opened (story.ts).
const HOME_STORIES = { shop: SHOP, research: RESEARCH, personal: PERSONAL } as const satisfies Readonly<Record<RecordedSandbox, HomeStory>>;

const isRecorded = (sandbox: HomeSandbox): sandbox is RecordedSandbox => Object.hasOwn(HOME_STORIES, sandbox);

/** The story a sandbox's home conversation holds; none for one the visitor made, whose home starts empty. */
export const homeStoryOf = (sandbox: HomeSandbox): HomeStory | undefined => (isRecorded(sandbox) ? HOME_STORIES[sandbox] : undefined);
