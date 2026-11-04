import type { Seal, SealPerson } from "@intentic/sandbox-contract/schemas/seal";
import { supervisorOf } from "../../auth/principal.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import type { PersistedAgent } from "../registry/agents-store.js";

/* A SEAL'S FAMILY: a private conversation and every conversation that carries its words at one remove (a subagent it
 * spawned, a review or test opened on its work, a fork cut from it), down every generation. They share one seal, kept on
 * the root and copied onto each with `from` naming the root, so a change to who reads the root is a change for all of
 * them, and a route aimed at any of them acts on the root. */

// Deeper than any spawn depth allows; a cycle in a corrupt record must not spin.
const MOST_GENERATIONS = 16;

// The conversation this one carries the words of: who supervises it, else what it was forked from.
export const sealSourceOf = (identity: Pick<PersistedAgent["identity"], "startedBy" | "fresh" | "forkedFrom">): string | undefined =>
    supervisorOf(identity) ?? identity.forkedFrom?.conversationId;

/** The root a conversation's seal is kept on: itself, unless it took its seal from another. */
export const sealRootOf = (entry: PersistedAgent): string => entry.seal?.from ?? entry.id;

const everyEntry = (agents: Services["agents"]): PersistedAgent[] =>
    [...agents.list(), ...agents.listArchived()].flatMap((summary) => agents.entry(summary.id) ?? []);

/** Every conversation below the root, by supervisor or fork, whatever its own seal says now. */
const familyBelow = (agents: Services["agents"], rootId: string): PersistedAgent[] => {
    const all = everyEntry(agents);
    const found: PersistedAgent[] = [];
    let frontier = [rootId];
    for (let generation = 0; frontier.length > 0 && generation < MOST_GENERATIONS; generation += 1) {
        const parents = new Set(frontier);
        const next = all.filter((entry) => !found.includes(entry) && entry.id !== rootId && parents.has(sealSourceOf(entry.identity) ?? ""));
        found.push(...next);
        frontier = next.map((entry) => entry.id);
    }
    return found;
};

/** A descendant's copy of the root's seal: everything but the asks, which are answered on the root alone. */
export const inheritedFrom = (rootId: string, seal: Seal): Seal => {
    const { asks: _asks, from: _from, ...kept } = seal;
    return { ...kept, from: rootId };
};

/** Writes the root's seal, or takes it away, and the same onto its whole family. Answers with the root's summary. */
export const writeFamilySeal = async (services: Pick<Services, "agents">, rootId: string, seal: Seal | undefined) => {
    const summary = await services.agents.setSeal(rootId, seal);
    for (const entry of familyBelow(services.agents, rootId)) {
        await services.agents.setSeal(entry.id, seal === undefined ? undefined : inheritedFrom(rootId, seal));
    }
    return summary;
};

/** A seal fresh on a conversation: its author reads it, and the people they named. */
export const freshSeal = (author: SealPerson, others: readonly SealPerson[], now: number): Seal => ({
    since: now,
    readers: [{ email: author.email.toLowerCase(), ...opt("name", author.name) }, ...others.filter((person) => person.email.toLowerCase() !== author.email.toLowerCase())],
});

/** A conversation's title where it leaves the conversation for everyone (a commit subject, a land's origin line): never a
 *  private one's, which reads as its id instead. */
export const sharedTitleOf = (entry: Pick<PersistedAgent, "seal" | "social">): string | undefined => (entry.seal === undefined ? entry.social.title?.text : undefined);
