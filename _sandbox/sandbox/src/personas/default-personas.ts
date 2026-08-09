import type { Persona } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import type { PersonasStore } from "./personas-store.js";

/* THE PERSONAS A WORKSPACE STARTS WITH — three answers to "what may this session do", written down so the
 * question has a shape before anybody has to invent one.
 *
 * A CATALOGUE OF SHELVES IS USELESS WITHOUT DEFAULTS. The powers on a card are a dozen switches, and a dozen
 * switches with no starting point is a form nobody fills in — the owner ends up leaving every session
 * unbounded, which is exactly the state this feature exists to move them off. These three are the shapes real
 * jobs actually take: something driven by a stranger, something that maintains the code, something that speaks
 * for the owner outside. An owner who wants a fourth copies the nearest one.
 *
 * EACH CARRIES NO ACCOUNTS. A persona names accounts by capability id, and this workspace's ids are not knowable
 * from here — so every seed arrives speaking for nobody, which is also the safe direction: a card that cannot
 * post is a card waiting to be told which account it speaks for, and the Personas page says so on its face.
 *
 * SEEDED ONCE, LIKE AN AUTOMATION, and through the same ledger for the same reason: "seed when absent" alone
 * would resurrect a card the owner deleted on every boot, which is an offer that cannot be refused. A recorded
 * id is never seeded again — absence-plus-record reads as their decision, absence alone as a workspace that has
 * not been offered it yet. */

const SeededSchema = z.object({ seeded: z.array(z.string()) });

// The Doorbell's persona: a stranger on a website is driving the prompt, so this is the card that gets the
// smallest toolbox in the product. Read and search, nothing else — no shell, no web fetches, no sub-agents, no
// edits, and no accounts to speak through. It replaces the hidden read-only allowlist the Doorbell used to
// carry, which did the same job invisibly and only for that one automation.
export const VISITOR_PERSONA = "visitor";
// The code chores: the nightly sweeps and the fix-what-broke jobs. Everything a developer needs and nothing
// that speaks outward — its own copy of the workspace, so a job that goes wrong goes wrong on a branch.
export const MAINTAINER_PERSONA = "maintainer";
// The one that speaks for the owner. Accounts and the browser, no shell and no workspace edits, and drafts
// rather than direct posts — so what it produces is reviewed before anybody outside sees it.
export const PUBLISHER_PERSONA = "publisher";

const DEFAULT_PERSONAS: readonly Persona[] = [
    {
        id: VISITOR_PERSONA,
        label: "Visitor",
        capabilities: [],
        voice: "You are answering someone who arrived from outside. Be brief and concrete, answer only from what is in the workspace, and say plainly when something is not something you can help with here.",
        powers: {
            files: "read",
            shell: false,
            web: false,
            browser: false,
            delegate: false,
            sandbox: false,
            connectors: [],
            computers: [],
            mcp: [],
        },
    },
    {
        id: MAINTAINER_PERSONA,
        label: "Maintainer",
        capabilities: [],
        voice: "You maintain this codebase. Prefer the smallest change that fixes the cause, keep the workspace's own conventions, and leave the tree building and its tests passing.",
        powers: {
            files: "write",
            shell: true,
            web: true,
            browser: true,
            delegate: true,
            // A maintenance job edits code, not the sandbox that runs it — and it runs unattended, which is
            // exactly when an accidental settings change is hardest to notice.
            sandbox: false,
        },
        workspace: { copy: "own" },
    },
    {
        id: PUBLISHER_PERSONA,
        label: "Publisher",
        // Add the accounts this speaks for on the Personas page — it arrives speaking for nobody on purpose.
        capabilities: [],
        posture: "draft",
        voice: "You write in the owner's voice for a public audience. Prepare drafts for approval; never send, post or reply directly.",
        powers: {
            // It reads the workspace to know what it is talking about, and changes nothing in it.
            files: "read",
            shell: false,
            web: true,
            browser: true,
            delegate: false,
            sandbox: false,
            connectors: [],
            computers: [],
            mcp: [],
        },
    },
];

export const seedDefaultPersonas = async (personas: PersonasStore, ledgerPath: string): Promise<void> => {
    const ledger = jsonFile<z.infer<typeof SeededSchema>>(ledgerPath, {
        parse: (raw) => SeededSchema.safeParse(raw).data,
        fallback: () => ({ seeded: [] }),
    });
    const record = await ledger.read();
    const existing = new Set((await personas.list()).map((persona) => persona.id));
    for (const persona of DEFAULT_PERSONAS) {
        if (record.seeded.includes(persona.id) || existing.has(persona.id)) {
            continue;
        }
        await personas.upsert(persona);
    }
    // Every default is recorded, including ones that already existed — an owner who hand-made a card under a
    // default's id has answered the offer too.
    const missing = DEFAULT_PERSONAS.filter((persona) => !record.seeded.includes(persona.id));
    if (missing.length > 0) {
        await ledger.update((current) => ({ seeded: [...current.seeded, ...missing.map((persona) => persona.id)] }));
    }
};
