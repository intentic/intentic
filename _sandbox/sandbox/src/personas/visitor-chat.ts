import { VISITOR_CHAT_PERSONA, type Persona } from "@intentic/sandbox-contract";
import type { PersonasStore } from "./personas-store.js";

// The one persona the daemon writes itself: a read-only persona a public web chat answers through, created only when a
// Visitor chat is saved, never seeded at boot. Re-created after deletion if a Visitor chat still exists, since it is a
// bound the persona must carry, not an offer to accept or refuse.

// Fixed manner of the Visitor chat product, not owner-composed wording; folded into the turn's persona guidance.
export const VISITOR_CHAT_GUIDANCE =
    "You are the visitor chat: you answer people who arrive from outside. Be brief and concrete, answer only from what is in the workspace, and say plainly when something is not something you can help with here.";

const VISITOR_CHAT_CARD: Persona = {
    id: VISITOR_CHAT_PERSONA,
    label: "Visitor chat",
    // Empty: workspace capability ids aren't knowable here; also the safe default, since it can't post as anyone.
    capabilities: [],
    // Smallest toolbox available: read and search only, since a stranger on a website drives this prompt.
    powers: {
        files: "read",
        shell: false,
        code: false,
        web: false,
        browser: false,
        delegate: false,
        sandbox: false,
        connectors: [],
        devices: [],
        mcp: [],
        extensions: [],
    },
    // No `systemPromptMode`: runs on the sandbox's base prompt; an owner can still add one, like any other persona.
};

// Writes only when absent: repairs a missing bound without resetting an owner's widened persona.
export const ensureVisitorChatPersona = async (personas: PersonasStore): Promise<void> => {
    if ((await personas.get(VISITOR_CHAT_PERSONA)) !== undefined) {
        return;
    }
    await personas.upsert(VISITOR_CHAT_CARD);
};
