import { CONVERSATION_BUNDLE_KIND, type ConversationBundle } from "@intentic/sandbox-contract/schemas/diagnostics";
import { DEMO_SANDBOX_NAME } from "../machine/definition";
import { agentAnswer, boardAgents } from "./roster";

// One conversation's debug bundle (sandbox-contract schemas/diagnostics.ts), as GET /fleet/{handle}/bundle answers the
// editor's "Download debug bundle": the card as `agents show` gives it, and the diagnostics answers worded for a daemon
// that keeps no log, which this one does not. The transcript is left out rather than invented: a bundle is a record of
// what happened, and the demo's recordings are replayed, not recorded. A conversation the board does not hold is refused
// as the daemon refuses it.

const NO_RECORD = `The demo keeps no daemon log, ledger or boot record, so there is nothing to read here.`;

export const conversationBundle = (id: string, now: number = Date.now()): ConversationBundle => {
    const agent = agentAnswer(boardAgents().find((card) => card.id === id));
    return {
        kind: CONVERSATION_BUNDLE_KIND,
        version: 1,
        exportedAt: new Date(now).toISOString(),
        sandbox: { name: DEMO_SANDBOX_NAME, version: `demo` },
        conversation: agent.id,
        show: { agent },
        transcript: { total: 0, rows: [] },
        timeline: NO_RECORD,
        turns: NO_RECORD,
        errors: NO_RECORD,
        restarts: NO_RECORD,
        browser: NO_RECORD,
    };
};
