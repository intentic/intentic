import { FRONT_DESK_PERSONA, type Persona } from "@intentic/sandbox-contract";
import type { PersonasStore } from "./personas-store.js";

/* THE ONE PERSONA THE DAEMON WRITES BY ITSELF — the read-only card a public web chat answers through, created
 * the moment a Front Desk is saved and never before.
 *
 * NOTHING IS SEEDED AT BOOT. A fresh workspace used to arrive with three stock cards — a read-only one, a
 * maintainer, a publisher — offered once each through a ledger so a deleted one stayed deleted. The argument for
 * them was that a persona is a dozen switches and a blank form is one nobody fills in, so a starting point beats
 * an empty page. What that missed is who pays: every owner who does not want personas at all still opened the
 * page to three rows they did not write, about accounts they had not connected, and the first thing the feature
 * asked of them was to understand and delete things. A workspace that needs no personas should look like it.
 *
 * SO THE CARD FOLLOWS THE NEED INSTEAD OF PRECEDING IT. A Front Desk is the one automation whose bounds cannot be
 * left to the prompt's wording — a stranger writes the prompt and nobody is watching the run — and it is pinned
 * to this card for exactly that reason. Creating it when a Front Desk is saved puts the bound on the Personas page
 * where the owner can SEE and widen it, which is what naming a persona buys over the hidden tool allowlist the
 * Front Desk used to carry. Every other card is theirs to write.
 *
 * NO LEDGER, AND THE DIFFERENCE MATTERS. A seed needed one because a boot-time offer that returns every boot
 * cannot be refused. This is not an offer — it is the card an act of the owner's requires, so re-creating it for
 * the next Front Desk after they deleted it is repairing a wake they just asked for, not overruling a decision. */

/* WHAT THE FRONT DESK IS TOLD, and the reason it is a constant here rather than a field on the card.
 *
 * A persona card carries no wording — it answers who a turn speaks as, what it may do and where it works, and
 * nothing an owner would have to compose (see PersonaSchema). This job is different in kind: the desk's manner
 * is the PRODUCT's, part of what a Front Desk is, the same on every workspace, and not something the owner was
 * ever asked to write. So it lives in the daemon beside the card the daemon writes, and the persona layer folds
 * it into that one turn's guidance (personaNote). An owner who widens the card keeps it — it is still the desk. */
export const FRONT_DESK_GUIDANCE =
    "You are the front desk: you answer people who arrive from outside. Be brief and concrete, answer only from what is in the workspace, and say plainly when something is not something you can help with here.";

const FRONT_DESK_CARD: Persona = {
    id: FRONT_DESK_PERSONA,
    label: "Front Desk",
    // Speaks for nobody. A card names accounts by capability id and this workspace's ids are not knowable from
    // here — which is also the safe direction: it arrives able to answer questions and unable to post as anyone.
    capabilities: [],
    // The smallest toolbox in the product, because a stranger on a website is driving the prompt. Read and
    // search, nothing else — no shell, no code runs, no web fetches, no sub-agents, no edits, no accounts to
    // speak through.
    powers: {
        files: "read",
        shell: false,
        code: false,
        web: false,
        browser: false,
        delegate: false,
        sandbox: false,
        connectors: [],
        computers: [],
        mcp: [],
    },
    /* No `systemPromptMode`, so the desk runs on the sandbox's own prompt whatever that is. The desk's MANNER is
     * the constant above rather than a prompt of its own, and for the same reason: what a Front Desk is belongs to
     * the product, while which base the agent runs on is the owner's to set for their whole sandbox. An owner
     * who wants the desk on a different prompt writes one on the card like any other persona. */
};

// Written only when absent, so an owner who has widened the card keeps their version — this repairs a MISSING
// bound, it does not reset one.
export const ensureFrontDeskPersona = async (personas: PersonasStore): Promise<void> => {
    if ((await personas.get(FRONT_DESK_PERSONA)) !== undefined) {
        return;
    }
    await personas.upsert(FRONT_DESK_CARD);
};
