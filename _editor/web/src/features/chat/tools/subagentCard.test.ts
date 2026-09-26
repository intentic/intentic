import type { SubagentSession, TranscriptSubagent } from "@intentic/sandbox-contract";
import { subagentView } from "./subagentCard";

// Pins what a card says of the subagent its call started, in-process and spawned alike: the turn's record, brought up
// to date by the roster, and working only on the word of something that can still vouch for it.

const spawned: TranscriptSubagent = {
    id: `sub-brave-otter`,
    kind: `spawned`,
    agentType: `Codex`,
    description: `Port the parser`,
    background: true,
    status: `running`,
    toolUses: 3,
};

const rostered = (over: Partial<SubagentSession>): SubagentSession => ({
    id: `sub-brave-otter`,
    kind: `spawned`,
    conversationId: `c1`,
    status: `running`,
    startedAt: 1,
    activityAt: 2,
    ...over,
});

const rosterOf =
    (...sessions: SubagentSession[]) =>
    (id: string): SubagentSession | undefined =>
        sessions.find((session) => session.id === id);

describe(`subagentView`, () => {
    it(`is nothing for a call that started no subagent`, () => {
        expect(subagentView(`t1`, undefined, rosterOf(), true)).toBeUndefined();
    });

    it(`names an in-process subagent by its card, and a spawned one by its own conversation`, () => {
        expect(subagentView(`call-1`, { kind: `subagent`, status: `running` }, undefined, true)?.id).toBe(`call-1`);
        expect(subagentView(`call-9`, spawned, undefined, true)?.id).toBe(`sub-brave-otter`);
    });

    // A spawned subagent works on after the turn that started it; the roster is how its card keeps up.
    it(`brings the turn's record up to date from the roster, keeping the card's own id and kind`, () => {
        const view = subagentView(
            `call-9`,
            spawned,
            rosterOf(rostered({ status: `completed`, summary: `Ported; two files changed.`, toolUses: 12, verification: { state: `unproven` } })),
            false,
        );
        expect(view).toEqual({
            id: `sub-brave-otter`,
            subagent: {
                id: `sub-brave-otter`,
                kind: `spawned`,
                agentType: `Codex`,
                description: `Port the parser`,
                background: true,
                status: `completed`,
                toolUses: 12,
                summary: `Ported; two files changed.`,
                verification: { state: `unproven` },
            },
            working: false,
            rostered: true,
        });
    });

    it(`calls it working while the turn streams it, or while the roster holds it working`, () => {
        expect(subagentView(`call-9`, spawned, rosterOf(), true)?.working).toBe(true);
        expect(subagentView(`call-9`, spawned, rosterOf(rostered({ status: `blocked` })), false)?.working).toBe(true);
    });

    // The turn ended and the roster let it go: what the record last said is a snapshot, not news.
    it(`never calls a record frozen at its turn's end working`, () => {
        expect(subagentView(`call-9`, spawned, rosterOf(), false)).toMatchObject({ working: false, rostered: false, subagent: { status: `running` } });
        expect(subagentView(`call-9`, spawned, undefined, false)?.working).toBe(false);
    });
});
