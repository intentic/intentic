import { VISITOR_CHAT_PERSONA, PersonaPowersSchema } from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";
import { memoryPersonasStore } from "../harness/route-stores.testing.js";
import { ensureVisitorChatPersona } from "./visitor-chat.js";

/* The persona follows the need. */
test("writes the visitor chat into a workspace that has no personas", async () => {
    const personas = memoryPersonasStore();
    await ensureVisitorChatPersona(personas);
    const persona = await personas.get(VISITOR_CHAT_PERSONA);
    // Read-only and speaking for nobody: the two properties a stranger-driven wake depends on.
    expect(persona?.powers).toMatchObject({ files: "read", shell: false, web: false, delegate: false });
    expect(persona?.capabilities).toEqual([]);
});

/* THE OWNER'S EDITS SURVIVE. */
test("leaves a visitor chat the owner has widened alone", async () => {
    const personas = memoryPersonasStore([
        {
            id: VISITOR_CHAT_PERSONA,
            label: "Visitor chat",
            capabilities: ["reddit-work"],
            powers: PersonaPowersSchema.parse({ files: "read", web: true }),
        },
    ]);
    await ensureVisitorChatPersona(personas);
    expect(await personas.get(VISITOR_CHAT_PERSONA)).toMatchObject({ capabilities: ["reddit-work"], powers: { web: true } });
    // And no second copy of the persona.
    expect(await personas.list()).toHaveLength(1);
});
