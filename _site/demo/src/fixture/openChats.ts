import type { StoredTab, TabSnapshot } from "@intentic/web/chat-tabs";
import { FEATURED_AGENT_ID } from "./fleet";

// Tabs the recording opens holding: the featured run focused, plus one chat per persona so the Personas rail isn't
// three empty rows. Personas do non-code work only (a support queue, a launch thread, a payouts reconciliation). Seeded
// into the real tab snapshot the app restores from, not bypassed.

export const MAYA_CHAT_ID = `cnv_maya_support`;
export const OWEN_CHAT_ID = `cnv_owen_launch`;
export const PRIYA_CHAT_ID = `cnv_priya_payouts`;

// Every seeded tab has the same ordinary shape (registered, shared tree, nothing typed or queued); only id, title and
// persona differ.
const tab = (conversationId: string, title: string, sessionId: string, actsAs?: string): StoredTab => ({
    conversationId,
    isolated: false,
    // Fleet has seen these; restore treats them as chats, not fresh draft cards.
    registered: true,
    provider: `claude`,
    harness: `claude-code`,
    model: `claude-sonnet-5`,
    effort: `high`,
    thinking: true,
    ...(actsAs === undefined ? {} : { actsAs }),
    // Session needs its runtime; a ref missing one is dropped on restore rather than kept unusable.
    session: { id: sessionId, provider: `claude`, harness: `claude-code`, account: `acc_claude_demo` },
    title,
    draft: ``,
    attachments: [],
    queued: [],
});

const OPEN_TABS: readonly StoredTab[] = [
    tab(FEATURED_AGENT_ID, `Add Stripe checkout to the pricing page`, `ses_01j9checkout`),
    tab(MAYA_CHAT_ID, `Morning support sweep & VIP save`, `ses_01j9maya`, `maya-support`),
    tab(OWEN_CHAT_ID, `Launch thread for 2.4`, `ses_01j9owen`, `owen-growth`),
    tab(PRIYA_CHAT_ID, `August payouts reconciliation`, `ses_01j9priya`, `priya-ops`),
];

// Strip opens with four tabs, the featured run focused, in the app's ordinary single-column layout.
export const openTabSnapshot = (): TabSnapshot => ({
    active: FEATURED_AGENT_ID,
    panes: [FEATURED_AGENT_ID],
    tabs: OPEN_TABS,
});
