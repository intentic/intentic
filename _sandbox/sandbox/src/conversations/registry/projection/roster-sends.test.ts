import { waitFor } from "@intentic/testing/bun";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { rosterSends, type RosterSource } from "./roster-sends.js";

// The registry's projection as a send reads it, counting what each send cost: a whole roster, or the cards asked for.
const counted = (): RosterSource & { readonly built: () => number; readonly asked: () => string[][] } => {
    let built = 0;
    const asked: string[][] = [];
    // SAFETY: a send only hands cards on; nothing here reads a field of one but its id.
    const card = (id: string): AgentSummary => ({ id }) as AgentSummary;
    return {
        list: () => {
            built += 1;
            return [card("c1"), card("c2")];
        },
        cardsOf: (ids) => {
            asked.push([...ids]);
            return ids.map(card);
        },
        built: () => built,
        asked: () => asked,
    };
};

const ids = (agents: AgentSummary[]): string[] => agents.map((agent) => agent.id);

describe("roster sends", () => {
    it("builds no whole roster for progress when every listener asked for changes, and one shared answer per send", () => {
        const source = counted();
        const sends = rosterSends(source, 0);
        const heard: { readonly ids: string[]; readonly rev: number; readonly whole: boolean }[][] = [[], []];
        for (const into of heard) {
            sends.subscribe((agents, rev, whole) => into.push({ ids: ids(agents), rev, whole }), "changes");
        }
        expect(source.built()).toBe(2);

        sends.progress("c2");
        expect(heard.map((sent) => sent.at(-1))).toEqual([
            { ids: ["c2"], rev: 1, whole: false },
            { ids: ["c2"], rev: 1, whole: false },
        ]);
        expect(source.built()).toBe(2);
        expect(source.asked()).toEqual([["c2"]]);

        // A change someone made is whole to everyone, built once for all of them.
        sends.broadcast();
        expect(heard.map((sent) => sent.at(-1))).toEqual([
            { ids: ["c1", "c2"], rev: 2, whole: true },
            { ids: ["c1", "c2"], rev: 2, whole: true },
        ]);
        expect(source.built()).toBe(3);
    });

    it("names each moved card once per send however often it moved, and only since the send before", async () => {
        const source = counted();
        const sends = rosterSends(source, 40);
        const changes: string[][] = [];
        const unsubscribe = sends.subscribe((agents, _rev, whole) => (whole ? undefined : changes.push(ids(agents))), "changes");

        sends.progress("c1");
        sends.progress("c2");
        sends.progress("c2");
        sends.progress("c1");
        // The first after a quiet spell goes at once; the rest of the burst waits for the window.
        expect(changes).toEqual([["c1"]]);
        await waitFor(() => expect(changes).toEqual([["c1"], ["c2", "c1"]]));
        expect(sends.revision()).toBe(4);
        unsubscribe();
    });
});
