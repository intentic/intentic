import { homeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";

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

export const homeMessages: TranscriptRow[] = [
    { role: `user`, text: `Morning. What should I focus on in the shop today?` },
    {
        role: `assistant`,
        text: `Morning! Three things are ready for a look:\n\n- **The new checkout** is ready to test.\n- **Friday's newsletter** needs a final read.\n- **Two customer questions** are waiting for a reply.\n\nI'd start with checkout, so customers can use it this week.`,
    },
    { role: `user`, text: `Let's do that. Check the checkout flow and tell me if anything needs fixing.` },
    {
        role: `assistant`,
        text: `I'll walk through it in the browser, from the product page to the order confirmation. Then I'll bring you a short report with anything that needs your attention.`,
    },
];
