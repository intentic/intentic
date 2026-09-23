import type { AgentTurn, Persona } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../../agents/registry/agents-store.js";
import { conversationEntry, isolatedAgent } from "../../testing.js";
import { contextNoteFor, decideComposition } from "./conversation-context.js";

/* THE COMPOSITION IS READ OFF THE CARD, AND OFF NOTHING ELSE. */

const CARDS: readonly Persona[] = [
    { id: "backend", label: "Backend", capabilities: [], context: { repos: ["api", "billing"] } },
    { id: "root-only", capabilities: [], context: { repos: [] } },
    { id: "open", capabilities: [] },
];

const services = (entry: PersistedAgent | undefined, root = "/nowhere"): Services =>
    unstubbed<Services>("services", {
        personas: unstubbed<Services["personas"]>("personas", { get: async (id) => CARDS.find((card) => card.id === id) }),
        agents: unstubbed<Services["agents"]>("agents", { entry: () => entry }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
    });

const turn = (actsAs: string | undefined): AgentTurn => ({ prompt: "hello", ...(actsAs === undefined ? {} : { actsAs }) }) as AgentTurn;

test("a card that names its context decides the composition, in the card's order", async () => {
    expect(await decideComposition(services(undefined), turn("backend"))).toEqual({ persona: "backend", repos: ["api", "billing"] });
    // Root alone is a real answer, distinct from "everything".
    expect(await decideComposition(services(undefined), turn("root-only"))).toEqual({ persona: "root-only", repos: [] });
});

test("no card, a card that says nothing, and a card that does not exist all carry everything", async () => {
    expect(await decideComposition(services(undefined), turn(undefined))).toBeUndefined();
    expect(await decideComposition(services(undefined), turn("open"))).toBeUndefined();
    // turnPersona already denies this turn every account and tool; the tree it cannot use may as well be whole.
    expect(await decideComposition(services(undefined), turn("gone"))).toBeUndefined();
});

test("the note names the card, what is carried, and what the workspace has that is not", async () => {
    // A root that is not there discovers no nested repositories (repo-discovery.ts reads an unreadable dir as
    // empty), so everything the composition names is "missing" and nothing is absent: the note still says
    // what the card asked for. The walk over a real tree is worktrees.integration.test.ts's business.
    const root = "/nowhere/intentic-context";
    const backend = isolatedAgent([], {
        placement: { kind: "worktree", branch: "agent/c1", repos: [], composition: { persona: "backend", repos: ["api"] } },
    });
    const note = await contextNoteFor(services(backend, root), "c1");
    expect(note?.title).toBe("Context of this session");
    expect(note?.text).toContain("(wearing the `Backend` persona)");
    expect(note?.text).toContain("Named by the persona but not in this workspace: `api`.");
    // A conversation with no composition has nothing to be told.
    expect(await contextNoteFor(services(conversationEntry({ id: "c2" }), root), "c2")).toBeUndefined();
});
