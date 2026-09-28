// Which subagent a chat shows in a parent's column, and when it steps back out; and what makes a spawned conversation a
// subagent whose chat is its parent's to direct.
import type { FleetAgent } from "../../../agents/fleet/useAgents-fleet";
import { Conversation } from "../../session/conversation";
import { closeSubagent, keepSubagentWhileShown, parentCardOf, showSubagent, subagentOnScreen, writesTo, writeTo } from "./subagentView";

afterEach(() => closeSubagent());

describe(`the subagent a chat shows`, () => {
    it(`is one at a time: another subagent replaces it`, () => {
        showSubagent(`lead`, `call-1`);
        showSubagent(`lead`, `call-2`);
        expect(subagentOnScreen.value).toEqual({ parentId: `lead`, id: `call-2` });
    });

    it(`steps back out only for its own parent when one is named`, () => {
        showSubagent(`lead`, `call-1`);
        closeSubagent(`other`);
        expect(subagentOnScreen.value).toEqual({ parentId: `lead`, id: `call-1` });
        closeSubagent(`lead`);
        expect(subagentOnScreen.value).toBeUndefined();
    });

    it(`lasts only while its parent's column is drawn`, () => {
        showSubagent(`lead`, `call-1`);
        keepSubagentWhileShown([`other`, `lead`]);
        expect(subagentOnScreen.value).toEqual({ parentId: `lead`, id: `call-1` });
        keepSubagentWhileShown([`other`]);
        expect(subagentOnScreen.value).toBeUndefined();
    });
});

describe(`parentCardOf`, () => {
    // Only what the rule reads; a card's other fields have no say in whose subagent it is.
    const card = (id: string): FleetAgent => ({ id, status: `running`, provider: `claude`, harness: `native` }) as FleetAgent;
    const fleet = new Map<string, FleetAgent>([
        [`lead`, card(`lead`)],
        [`filed`, { ...card(`filed`), archivedAt: 5 }],
    ]);
    const cardOf = (id: string): FleetAgent | undefined => fleet.get(id);

    it(`names the parent a spawned conversation's card points at, while that parent is on the fleet`, () => {
        expect(parentCardOf({ ...card(`child`), startedBy: `agent:lead` }, cardOf)?.id).toBe(`lead`);
    });

    it(`leaves a child whose parent is archived or gone a conversation in its own right`, () => {
        expect(parentCardOf({ ...card(`child`), startedBy: `agent:filed` }, cardOf)).toBeUndefined();
        expect(parentCardOf({ ...card(`child`), startedBy: `agent:gone` }, cardOf)).toBeUndefined();
        expect(parentCardOf(card(`solo`), cardOf)).toBeUndefined();
    });
});

it(`remembers, per conversation, that the reader chose to write to a subagent directly`, () => {
    const child = new Conversation(`child`);
    expect(writesTo(child)).toBe(false);
    writeTo(child);
    expect(writesTo(child)).toBe(true);
    expect(writesTo(new Conversation(`other`))).toBe(false);
});
