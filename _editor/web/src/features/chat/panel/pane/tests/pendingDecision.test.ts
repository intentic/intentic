import { NO_ATTENTION } from "../../../../agents/fleet/agentStatus";
import type { ChatMessage } from "../../../transcript/transcript";
import { pendingCardOf, pendingDecisionOf, waitKindOf } from "../pendingDecision";

// What the bar over the composer names: the newest card still waiting, read the way the card titles itself, else what
// the agents list says the chat waits for.

const QUESTION = { header: ``, multiSelect: false, options: [{ label: `MIT`, description: `` }] };

it(`names the newest card still waiting, titled as the card is`, () => {
    const rows: ChatMessage[] = [
        { id: 1, role: `assistant`, text: ``, plan: { requestId: `p1`, text: `# Old plan`, status: `approved` } },
        { id: 2, role: `assistant`, text: ``, permission: { requestId: `r1`, toolName: `Bash`, displayName: `Run a command`, status: `pending` } },
        {
            id: 3,
            role: `assistant`,
            text: ``,
            question: { requestId: `q1`, questions: [{ ...QUESTION, question: `Which licence?` }], status: `pending` },
        },
    ];

    expect(pendingCardOf(rows)).toEqual({ kind: `question`, requestId: `q1`, title: `Which licence?` });
    expect(pendingCardOf(rows.slice(0, 2))).toEqual({ kind: `permission`, requestId: `r1`, title: `Run a command` });
    expect(pendingCardOf(rows.slice(0, 1))).toBeUndefined();
});

// A hand-off card (a terminal, a browser, an offer) is drawn like the rest: its id lets the bar scroll to it.
it(`names any other drawn card still waiting by its request id`, () => {
    const rows: ChatMessage[] = [
        { id: 1, role: `assistant`, text: ``, terminalHelp: { requestId: `t1`, session: `work`, message: `Type the passphrase`, status: `pending` } },
    ];

    expect(pendingCardOf(rows)).toEqual({ kind: `other`, requestId: `t1` });
});

it(`leaves a card of several questions untitled, as the card is`, () => {
    const rows: ChatMessage[] = [
        {
            id: 1,
            role: `assistant`,
            text: ``,
            question: {
                requestId: `q1`,
                questions: [
                    { ...QUESTION, question: `Which licence?` },
                    { ...QUESTION, question: `Which year?` },
                ],
                status: `pending`,
            },
        },
    ];

    expect(pendingCardOf(rows)).toEqual({ kind: `question`, requestId: `q1` });
});

it(`reads the agents list in the board's rank when nothing is drawn, and a drawn card over it`, () => {
    expect(waitKindOf({ status: `awaiting`, attention: { ...NO_ATTENTION, question: true, plan: true } })).toBe(`plan`);
    expect(waitKindOf({ status: `awaiting`, attention: { ...NO_ATTENTION, permission: true } })).toBe(`permission`);
    expect(waitKindOf({ status: `awaiting`, attention: NO_ATTENTION })).toBe(`other`);
    expect(waitKindOf({ status: `running`, attention: NO_ATTENTION })).toBeUndefined();

    expect(pendingDecisionOf([], `question`)).toEqual({ kind: `question` });
    expect(pendingDecisionOf([], undefined)).toBeUndefined();
    const drawn: ChatMessage[] = [{ id: 1, role: `assistant`, text: ``, plan: { requestId: `p1`, text: `# Ship it`, status: `pending` } }];
    expect(pendingDecisionOf(drawn, `question`)).toEqual({ kind: `plan`, requestId: `p1`, title: `Ship it` });
});
