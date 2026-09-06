import type { AgentTurn, Persona } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { Services } from "../../composition.js";
import type { Composition } from "../../agents/registry/agents-store.js";
import { contextNoteFor, decideComposition } from "./conversation-context.js";

/* THE COMPOSITION IS READ OFF THE CARD, AND OFF NOTHING ELSE. Three cards: one that names its context, one that
 * says nothing about it, and the absence of one. The first narrows the tree, the other two are "everything",
 * which is spelled as no composition at all so the worktree layer keeps the freeze it always had. */

const CARDS: readonly Persona[] = [
    { id: "backend", label: "Backend", capabilities: [], context: { repos: ["api", "billing"] } },
    { id: "root-only", capabilities: [], context: { repos: [] } },
    { id: "open", capabilities: [] },
];

const services = (entry: { readonly composition?: Composition } | undefined, root = "/nowhere"): Services =>
    unstubbed<Services>("services", {
        personas: unstubbed<Services["personas"]>("personas", { get: async (id) => CARDS.find((card) => card.id === id) }),
        agents: unstubbed<Services["agents"]>("agents", { entry: () => entry as ReturnType<Services["agents"]["entry"]> }),
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
    const note = await contextNoteFor(services({ composition: { persona: "backend", repos: ["api"] } }, root), "c1");
    expect(note?.title).toBe("Context of this session");
    expect(note?.text).toContain("(wearing the `Backend` persona)");
    expect(note?.text).toContain("Named by the persona but not in this workspace: `api`.");
    // A conversation with no composition has nothing to be told.
    expect(await contextNoteFor(services({}, root), "c2")).toBeUndefined();
});
