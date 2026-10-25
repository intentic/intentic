import type { AgentStatus } from "../schemas/agents.js";
import { attentionCalls, attentionCards } from "./agent-lanes.js";
import { automationOf, stackHeads } from "./agent-stack.js";

const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const LANDED: AgentStatus = `landed`;
const ERROR: AgentStatus = `error`;

type Over = { status?: AgentStatus; updatedAt?: number; startedAt?: number; startedBy?: string; failureCode?: string; attention?: typeof none };

// One run of the automation `x-follow`, as the daemon now records it, settled at `updatedAt`.
const run = (id: string, over: Over = {}) => ({
    id,
    status: LANDED,
    attention: none,
    updatedAt: 0,
    origin: { automationId: `x-follow`, provider: `schedule` },
    ...over,
});
const person = (id: string, over: Over = {}) => ({ id, status: LANDED, attention: none, updatedAt: 0, ...over });

describe("automationOf", () => {
    test("names the automation from the origin, else from the id the daemon minted the run under", () => {
        expect(automationOf({ id: `anything`, origin: { automationId: `x-follow` } })).toBe(`x-follow`);
        // Runs a schedule fired before origins were recorded: `a-<automation>-<base36 stamp>`.
        expect(automationOf({ id: `a-x-follow-mvn5x1jtu` })).toBe(`x-follow`);
        expect(automationOf({ id: `a-nightly-mvn5x1j16` })).toBe(`nightly`);
    });

    test("names none for a conversation a person started", () => {
        expect(automationOf({ id: `witty-harbor-pknz` })).toBeUndefined();
        expect(automationOf({ id: `home-1a2b3c4d5e6f7a8b` })).toBeUndefined();
        expect(automationOf({ id: `a-` })).toBeUndefined();
    });
});

describe("stackHeads", () => {
    test("picks each automation's latest run, a running turn by its start so two at work never trade places", () => {
        const heads = stackHeads(
            [run(`r1`, { updatedAt: 100 }), run(`r2`, { updatedAt: 300 }), run(`r3`, { status: `running`, startedAt: 200, updatedAt: 900 })],
            automationOf,
        );
        expect(heads.get(`x-follow`)?.id).toBe(`r2`);
        const working = stackHeads([run(`old`, { status: `running`, startedAt: 100, updatedAt: 990 }), run(`new`, { status: `running`, startedAt: 200, updatedAt: 210 })], automationOf);
        expect(working.get(`x-follow`)?.id).toBe(`new`);
    });

    test("keeps out whatever the key names no automation for", () => {
        expect(stackHeads([person(`p`, { updatedAt: 5 })], automationOf).size).toBe(0);
    });
});

// The rail badge counts an automation's runs as the board draws them: one card, its latest run's.
describe("attentionCards over an automation's runs", () => {
    const failed = { status: ERROR };

    test("counts nothing for earlier failures a later run has moved past", () => {
        const fleet = [run(`r1`, { ...failed, updatedAt: 100 }), run(`r2`, { ...failed, updatedAt: 200 }), run(`r3`, { updatedAt: 300 })];
        expect(attentionCards(fleet)).toBe(0);
    });

    test("counts the stack once when its latest run failed, however many before it did", () => {
        const fleet = [run(`r1`, { ...failed, updatedAt: 100 }), run(`r2`, { ...failed, updatedAt: 200 }), run(`r3`, { ...failed, updatedAt: 300 })];
        expect(attentionCards(fleet)).toBe(1);
        expect(attentionCalls(fleet).map((call) => call.card)).toEqual([`r3`]);
    });

    test("counts an earlier run asking what only the reader can give, through the stack's card", () => {
        const fleet = [run(`r1`, { status: `awaiting`, attention: { ...none, credential: true }, updatedAt: 100 }), run(`r2`, { updatedAt: 300 })];
        expect(attentionCalls(fleet)).toEqual([{ id: `r1`, card: `r2` }]);
    });

    test("keeps a person's own work out of any stack", () => {
        const fleet = [run(`r1`, { updatedAt: 300 }), person(`mine`, { ...failed, updatedAt: 100 })];
        expect(attentionCalls(fleet)).toEqual([{ id: `mine`, card: `mine` }]);
    });

    test("lets a run's own child ride its parent run, and so the stack", () => {
        const fleet = [
            run(`r1`, { updatedAt: 100 }),
            run(`r2`, { updatedAt: 300 }),
            person(`helper`, { startedBy: `agent:r1`, status: `awaiting`, attention: { ...none, permission: true }, updatedAt: 150 }),
        ];
        expect(attentionCalls(fleet)).toEqual([{ id: `helper`, card: `r2` }]);
    });
});
