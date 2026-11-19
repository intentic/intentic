import type { PersistedAgent } from "../../../conversations/registry/agents-store.js";
import { proceedsWithoutAsking } from "./proceed.js";

// Whose answer a turn proceeds by: its own, else the nearest one up the conversations that started it, else the
// sandbox's. A subagent of a parent switched on for the night proceeds too, with nothing written into its prompt.

type Entry = Pick<PersistedAgent, "postures" | "identity">;

const entry = (proceed: boolean | undefined, startedBy?: string): Entry => ({
    postures: proceed === undefined ? {} : { proceed },
    identity: startedBy === undefined ? {} : { startedBy },
});

const lookup =
    (entries: Record<string, Entry>) =>
    (id: string): Entry | undefined =>
        entries[id];

const OFF = { proceedWithoutAsking: false };
const ON = { proceedWithoutAsking: true };

describe("proceeding without asking", () => {
    it("follows the sandbox when nothing says otherwise", () => {
        expect(proceedsWithoutAsking(OFF, entry(undefined), lookup({}))).toBe(false);
        expect(proceedsWithoutAsking(ON, entry(undefined), lookup({}))).toBe(true);
        expect(proceedsWithoutAsking(ON, undefined, lookup({}))).toBe(true);
    });

    it("takes the conversation's own answer over the sandbox's, either way", () => {
        expect(proceedsWithoutAsking(OFF, entry(true), lookup({}))).toBe(true);
        expect(proceedsWithoutAsking(ON, entry(false), lookup({}))).toBe(false);
    });

    it("carries a parent's answer to its subagents, and theirs, unless one says otherwise", () => {
        const fleet = lookup({ parent: entry(true), child: entry(undefined, "agent:parent"), opted: entry(false, "agent:parent") });
        expect(proceedsWithoutAsking(OFF, entry(undefined, "agent:child"), fleet)).toBe(true);
        expect(proceedsWithoutAsking(OFF, entry(undefined, "agent:opted"), fleet)).toBe(false);
        // A person who started it is no conversation to inherit from.
        expect(proceedsWithoutAsking(OFF, entry(undefined, "owner@acme.dev"), fleet)).toBe(false);
    });

    it("stops climbing a loop in the records and falls back to the sandbox", () => {
        const loop = lookup({ a: entry(undefined, "agent:b"), b: entry(undefined, "agent:a") });
        expect(proceedsWithoutAsking(ON, entry(undefined, "agent:a"), loop)).toBe(true);
    });
});
