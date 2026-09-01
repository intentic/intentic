// The app's own description of a persisted tab, reached through its package export the same way this package
// reaches the app's entry, so a change to the strip's stored shape breaks this build rather than the demo.
import type { StoredTab, TabSnapshot } from "@intentic-app/web/chat-tabs";
import { FEATURED_AGENT_ID } from "./fleet";

/* THE CHATS THE RECORDING OPENS HOLDING, the tab strip a visitor arrives with, and the conversation the
 * docked chat is already showing.
 *
 * It used to hold nothing, and the demo opened on an empty "New agent" draft beside a board with three agents
 * on it: a first frame whose largest panel said "Start a conversation with Claude Code" over a workspace that
 * plainly already had three. Two things are seeded instead.
 *
 * THE FEATURED RUN, focused. It is the turn the recording is built around (turn.ts) and it parks on a plan
 * card until somebody answers it, so opening on it costs nothing and gains the demo's whole opening beat,
 * the visitor's first press is approving a plan rather than finding the card that offers one.
 *
 * ONE CHAT PER PERSONA, behind it. A persona is a card the sandbox can send as, a name, a face, and the
 * accounts that name reaches (the `/personas` route in daemon.ts serves the three). But the chat rail's
 * Personas cut is not built from that list alone: a row counts the conversations THIS WINDOW is holding for
 * that person, because the pick lives on the conversation and nowhere else (ChatPersonaRail.vue explains why).
 * A recording that served three personas and no chats pinned to them rendered three empty rows, the surface
 * present and the thing it exists to show absent.
 *
 * They are WORK, not chat, and none of it is code: a support queue, a launch thread, a payouts
 * reconciliation, each through accounts a coding agent has no business holding. That contrast is the whole
 * argument for personas being in this product, and three titles make it without a paragraph.
 *
 * All of it is seeded into the tab snapshot the app restores from (composables/chat/tabSnapshot.ts) exactly
 * the way this demo seeds a session into localStorage: not a fake, not a code path bypassed, the app finds
 * what it is looking for and rehydrates four ordinary tabs.
 */

export const MAYA_CHAT_ID = `cnv_maya_support`;
export const OWEN_CHAT_ID = `cnv_owen_launch`;
export const PRIYA_CHAT_ID = `cnv_priya_payouts`;

// Every seeded tab is the same ordinary shape: registered with the fleet, on the shared tree, nothing typed,
// nothing queued. Only the identity, the title and the person differ.
const tab = (conversationId: string, title: string, sessionId: string, actsAs?: string): StoredTab => ({
    conversationId,
    isolated: false,
    // The fleet has seen these conversations, so a restore hands them back as chats rather than re-offering
    // them to the board as fresh draft cards.
    registered: true,
    provider: `claude`,
    harness: `claude-code`,
    model: `claude-sonnet-5`,
    effort: `high`,
    thinking: true,
    ...(actsAs === undefined ? {} : { actsAs }),
    // The session with what minted it, all of it: a ref missing its runtime is dropped on restore (a session
    // nothing can decide "does my next message resume this?" with is worse than none), and these tabs exist to
    // come back as chats mid-conversation.
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

/* The strip as the recording opens it: four tabs, the featured run focused, and ONE pane, the app's ordinary
 * single-column chat. Splitting the column would be a second thing to explain in the first frame.
 */
export const openTabSnapshot = (): TabSnapshot => ({
    active: FEATURED_AGENT_ID,
    panes: [FEATURED_AGENT_ID],
    tabs: OPEN_TABS,
});
