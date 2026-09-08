import { FRONT_DESK_PERSONA, type Persona } from "@intentic/sandbox-contract";
import type { PersonasStore } from "./personas-store.js";

// The one persona the daemon writes itself: a read-only card a public web chat answers through, created only when a
// Front Desk is saved, never seeded at boot. Re-created after deletion if a Front Desk still exists, since it is a
// bound the card must carry, not an offer to accept or refuse.

// Fixed manner of the Front Desk product, not owner-composed wording; folded into the turn's persona guidance.
export const FRONT_DESK_GUIDANCE =
    "You are the front desk: you answer people who arrive from outside. Be brief and concrete, answer only from what is in the workspace, and say plainly when something is not something you can help with here.";

const FRONT_DESK_CARD: Persona = {
    id: FRONT_DESK_PERSONA,
    label: "Front Desk",
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
    },
    // No `systemPromptMode`: runs on the sandbox's base prompt; an owner can still add one, like any other persona.
};

// Writes only when absent: repairs a missing bound without resetting an owner's widened card.
export const ensureFrontDeskPersona = async (personas: PersonasStore): Promise<void> => {
    if ((await personas.get(FRONT_DESK_PERSONA)) !== undefined) {
        return;
    }
    await personas.upsert(FRONT_DESK_CARD);
};
