import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { accountMovedRow } from "@intentic/sandbox-contract/text/notice-rows";
import { TranscriptFold } from "@intentic/sandbox-contract/transcript-fold";
import { incidentsOf } from "./chatIncidents";
import type { ChatMessage } from "./transcript";

// The rows the pane does not draw, and the incident each drawn row stands for: asked again on every frame of a streamed
// turn, so an answer that did not change must come back as the same object, or every row keyed on it is drawn again.

const ORG_OFF = `Your organization has disabled Claude Code`;
const refusal = { kind: `error`, code: `claude-not-entitled`, message: ORG_OFF, held: { ran: false } } as const satisfies AgentEvent;
const refused = (id: number, at: number): ChatMessage => {
    const fold = new TranscriptFold([], () => at);
    fold.apply(refusal);
    return { id, ...fold.rows.at(-1)! };
};
const moved: ChatMessage = { id: 9, ...accountMovedRow({ why: `refused`, from: `Work`, to: `Home`, said: ORG_OFF }) };

describe(`incidentsOf`, () => {
    it(`draws a run as its last row and folds the rest away`, () => {
        const answer = incidentsOf([{ id: 1, role: `user`, text: `go` }, refused(2, 10), refused(3, 20), moved]);
        expect([...answer.folded]).toEqual([2, 3]);
        expect(answer.drawn.get(9)).toEqual({
            attempts: [
                { at: 10, said: ORG_OFF },
                { at: 20, said: ORG_OFF },
            ],
            resolved: true,
        });
    });

    it(`hands back the same answer while nothing in it changed, and the same incident while only another run grew`, () => {
        const rows = [refused(2, 10), refused(3, 20)];
        const first = incidentsOf(rows);
        expect(incidentsOf([...rows, { id: 4, role: `assistant`, text: `on it` }], first)).toBe(first);
        const grown = incidentsOf([...rows, { id: 4, role: `user`, text: `again` }, refused(5, 30), refused(6, 40)], first);
        expect(grown).not.toBe(first);
        expect(grown.drawn.get(3)).toBe(first.drawn.get(3));
    });

    // A person's own pick in the composer ends the run as the sandbox's move does; a model swap, unmarked, does not.
    it(`ends a run on this window's own line for a switch it marked`, () => {
        const switched: ChatMessage = { id: 7, role: `notice`, text: `Switched to the Home account`, local: true, switched: true };
        expect(incidentsOf([refused(2, 10), switched]).drawn.get(7)).toMatchObject({ resolved: true });
        expect(incidentsOf([refused(2, 10), { ...switched, switched: undefined }]).drawn.size).toBe(0);
    });

    // Once the turn goes, the record says the switch itself (the daemon's `switched` row) and this window's line is
    // dropped: that row ends the run too, unless it only swapped the model.
    it(`ends a run on the record's own row for a switch to another account, but not for a model swap`, () => {
        const recorded = (segment: string): ChatMessage => ({
            id: 7,
            role: `notice`,
            text: `Switched to the Home account: same session, so the model re-reads the conversation once.`,
            noticeCode: { code: `switched`, params: { segment, provider: `claude`, fresh: false } },
        });
        expect(incidentsOf([refused(2, 10), recorded(`account`)]).drawn.get(7)).toMatchObject({ resolved: true });
        expect(incidentsOf([refused(2, 10), recorded(`model`)]).drawn.size).toBe(0);
    });
});
