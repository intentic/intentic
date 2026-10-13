import { unstubbed } from "@intentic/testing";
import type { UsageWindow } from "@intentic/sandbox-contract";
import { pino } from "pino";
import type { Services } from "../../../../composition.js";
import { HELD_AT_THE_DOOR, sandboxStarted, spentDoor } from "../spent-door.js";

/* A rebuild's restart re-ran three Codex subagents onto an allowance every account read as spent, and two of them sat on
   the translator's Retry-After as working (2026-10-13). What the sandbox starts by itself is held at the door instead;
   what a person sends always goes. */

const NOW = Date.now();
const IN_AN_HOUR = Math.floor(NOW / 1000) + 3_600;

const fiveHour = (utilization: number, resetsAt?: number): UsageWindow =>
    resetsAt === undefined ? { kind: `five_hour`, utilization, gates: `all` } : { kind: `five_hour`, utilization, gates: `all`, resetsAt };

// One Claude account, read as the account rows read it.
const claude = (windows: readonly UsageWindow[]): Services =>
    unstubbed<Services>(`services`, {
        claudeStore: unstubbed<Services[`claudeStore`]>(`claudeStore`, {
            // SAFETY: the verdict reads an account's id alone from the store's rows; the rest is the row's own business.
            list: async () => [{ id: `one` }] as Awaited<ReturnType<Services[`claudeStore`][`list`]>>,
        }),
        claudeSeats: unstubbed<Services[`claudeSeats`]>(`claudeSeats`, { read: async () => ({}) }),
        accountUsage: unstubbed<Services[`accountUsage`]>(`accountUsage`, { read: async () => ({ one: { windows: [...windows], measuredAt: NOW } }) }),
        providerRefusals: unstubbed<Services[`providerRefusals`]>(`providerRefusals`, { onFile: async () => ({}) }),
        logger: pino({ level: `silent` }),
    });

const turn = { conversationId: `child-1`, agent: `claude`, model: `claude-opus-5-5` };

describe(`which turns the sandbox started by itself`, () => {
    it(`counts a restart's re-run, whoever first said its words`, () => {
        expect(sandboxStarted({ resume: `restart`, speaker: { kind: `person`, email: `ada@example.com` } })).toBe(true);
    });

    it(`counts words no person typed: a parent's, a watch's, an unattributed one`, () => {
        expect(sandboxStarted({ speaker: { kind: `agent`, conversationId: `parent` } })).toBe(true);
        expect(sandboxStarted({ speaker: { kind: `sandbox`, source: `watch` } })).toBe(true);
        expect(sandboxStarted({})).toBe(true);
    });

    it(`never counts a person's own message, or any press on a held turn`, () => {
        expect(sandboxStarted({ speaker: { kind: `person`, email: `ada@example.com` } })).toBe(false);
        expect(sandboxStarted({ resume: `limit`, speaker: { kind: `agent`, conversationId: `parent` } })).toBe(false);
        expect(sandboxStarted({ resume: `continued` })).toBe(false);
    });
});

describe(`the door a sandbox-started turn passes`, () => {
    it(`holds it on an allowance every account has spent, until the reopening the records name`, async () => {
        const held = await spentDoor(claude([fiveHour(100, IN_AN_HOUR)]), { ...turn, speaker: { kind: `agent`, conversationId: `parent` } }, NOW);

        expect(held).toMatchObject({ kind: `error`, code: `rate_limit`, resetsAt: IN_AN_HOUR });
        expect(held?.message).toContain(HELD_AT_THE_DOOR);
    });

    it(`lets a person's own message through whatever the records say`, async () => {
        await expect(spentDoor(claude([fiveHour(100, IN_AN_HOUR)]), { ...turn, speaker: { kind: `person`, email: `ada@example.com` } }, NOW)).resolves.toBeUndefined();
    });

    it(`lets it through while any room is left`, async () => {
        await expect(spentDoor(claude([fiveHour(96, IN_AN_HOUR)]), { ...turn, resume: `restart` }, NOW)).resolves.toBeUndefined();
    });

    // Held with no reopening, it would wait on a press nothing tells anyone to make; the provider's own refusal says more.
    it(`lets it through when the spent allowance names no reopening`, async () => {
        await expect(spentDoor(claude([fiveHour(100)]), { ...turn, resume: `restart` }, NOW)).resolves.toBeUndefined();
    });

    it(`holds nothing that is not a conversation's`, async () => {
        await expect(spentDoor(claude([fiveHour(100, IN_AN_HOUR)]), { agent: `claude`, resume: `restart` }, NOW)).resolves.toBeUndefined();
    });
});
