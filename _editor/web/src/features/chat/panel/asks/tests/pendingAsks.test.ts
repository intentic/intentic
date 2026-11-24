import { type Need, NeedSchema } from "@intentic/sandbox-contract/schemas/needs";
import { NO_ATTENTION } from "../../../../../models/agent-status/agentStatus-lanes";
import { type AskSources, type ChildStanding, dockedBody, type PendingAsk, pendingAsksReader, waitKindOf } from "../../../../../models/conversations/panel/pendingAsks";
import type { ChatMessage } from "../../../../../models/conversations/transcript/transcript";
import { everyOf } from "../../../../../models/conversations/transcript/transcriptScan";

// Everything a chat waits on a person for, as the dock above its composer lists it: every ask, oldest first, so the first
// thing asked is the first thing shown and the count is all of them. The bar it replaced named only the newest card.

const QUESTION = { header: ``, multiSelect: false, options: [{ label: `MIT`, description: `` }] };

const needOf = (id: string, subject: Need[`subject`], extra: Partial<Need> = {}): Need =>
    NeedSchema.parse({ id, conversationId: `c1`, subject, title: `The ${id} need`, status: `open`, createdAt: 1, updatedAt: 1, ...extra });
const SECRET = needOf(`n1`, { kind: `secret`, name: `NPM_TOKEN`, where: `the publish step` });
const TOOL = needOf(`n2`, { kind: `environment`, tool: `ffmpeg`, steps: `RUN apt-get install -y ffmpeg` }, { createdAt: 5 });

// Each test reads its transcript once, so a fresh reader each time.
const pendingAsksOf = (messages: readonly ChatMessage[], sources: AskSources): readonly PendingAsk[] => pendingAsksReader()(messages, sources);

const NOBODY: AskSources = { ended: false, needs: [], needById: () => undefined, children: [], waitsOn: undefined };
const keys = (messages: readonly ChatMessage[], sources: Partial<AskSources> = {}): string[] =>
    pendingAsksOf(messages, { ...NOBODY, ...sources }).map((ask) => ask.key);

const ROWS: ChatMessage[] = [
    { id: 1, role: `assistant`, text: ``, plan: { requestId: `p0`, text: `# Old plan`, status: `approved` } },
    { id: 2, role: `assistant`, text: ``, permission: { requestId: `r1`, toolName: `Bash`, displayName: `Run a command`, status: `pending` } },
    { id: 3, role: `notice`, text: ``, need: SECRET },
    { id: 4, role: `assistant`, text: ``, question: { requestId: `q1`, questions: [{ ...QUESTION, question: `Which licence?` }], status: `pending` } },
];

describe(`the asks a chat waits on`, () => {
    it(`are every pending card and open need, in the order they were asked`, () => {
        expect(keys(ROWS, { needs: [SECRET] })).toEqual([`card:r1`, `need:n1`, `card:q1`]);
    });

    it(`read a need's row as its card does: live where the store holds it, else as the row recorded it`, () => {
        // The store holds nothing for it (pruned, another sandbox): the row's own record, which says open.
        expect(keys(ROWS)).toEqual([`card:r1`, `need:n1`, `card:q1`]);
        // The store says it was answered: gone, whatever the row recorded.
        const answered = needOf(`n1`, SECRET.subject, { status: `met` });
        expect(keys(ROWS, { needById: (id) => (id === `n1` ? answered : undefined) })).toEqual([`card:r1`, `card:q1`]);
    });

    it(`add the open needs this window holds no row for, in the order raised, after the transcript's`, () => {
        expect(keys(ROWS.slice(0, 2), { needs: [TOOL, SECRET] })).toEqual([`card:r1`, `need:n1`, `need:n2`]);
    });

    it(`drop the cards of a turn a person ended, keeping the needs, which outlive it`, () => {
        expect(keys(ROWS, { ended: true, needs: [SECRET] })).toEqual([`need:n1`]);
    });

    it(`stand on the agents list's word only until a card is drawn`, () => {
        expect(keys([], { waitsOn: `question` })).toEqual([`undrawn`]);
        expect(keys(ROWS, { waitsOn: `question` })).toEqual([`card:r1`, `need:n1`, `card:q1`]);
        expect(keys([], { waitsOn: `question`, ended: true })).toEqual([]);
    });

    // A child's question is its parent agent's to answer; only what the parent cannot answer reaches the reader.
    it(`include a child only for what only a person can answer`, () => {
        const child = (id: string, attention: Partial<ChildStanding[`attention`]>): ChildStanding => ({
            id,
            title: `Child ${id}`,
            status: `awaiting`,
            attention: { ...NO_ATTENTION, ...attention },
        });
        const asks = pendingAsksOf([], { ...NOBODY, children: [child(`k1`, { permission: true }), child(`k2`, { question: true })] });
        expect(asks.map((ask) => [ask.key, ask.source === `child` ? ask.kind : ``, ask.label])).toEqual([[`child:k1`, `permission`, `Child k1`]]);
    });
});

describe(`how an ask is named and drawn`, () => {
    it(`names each by the few words a person would use, and carries the card it draws`, () => {
        const rows: ChatMessage[] = [
            {
                id: 1,
                role: `assistant`,
                text: ``,
                question: {
                    requestId: `q2`,
                    questions: [
                        { ...QUESTION, header: `Licence`, question: `Which licence?` },
                        { ...QUESTION, header: `Scope`, question: `Which packages?` },
                    ],
                    status: `pending`,
                },
            },
            {
                id: 2,
                role: `assistant`,
                text: ``,
                permission: {
                    requestId: `r2`,
                    toolName: `mcp__subagents__spawn`,
                    displayName: `Start it`,
                    child: { move: `spawn`, task: `Fix the ps1 kit`, provider: `claude`, model: `claude-opus-5-5` },
                    status: `pending`,
                },
            },
            { id: 3, role: `assistant`, text: ``, plan: { requestId: `p1`, text: `# Ship the importer\n\nSteps.`, status: `pending` } },
            { id: 4, role: `notice`, text: ``, need: SECRET },
        ];
        const asks = pendingAsksOf(rows, NOBODY);
        expect(asks.map((ask) => [ask.label, ask.icon, dockedBody(ask)])).toEqual([
            [`Licence · Scope`, `comments`, true],
            // A child start by the child it starts, never its button's words.
            [`Fix the ps1 kit`, `subagents`, true],
            // A plan is read in the transcript; the dock carries its answers.
            [`Ship the importer`, `list-check`, false],
            [`NPM_TOKEN`, `key`, true],
        ]);
    });

    it(`ranks what the agents list says a chat waits on as the board does`, () => {
        expect(waitKindOf({ status: `awaiting`, attention: { ...NO_ATTENTION, plan: true, question: true } })).toBe(`plan`);
        expect(waitKindOf({ status: `awaiting`, attention: NO_ATTENTION })).toBe(`other`);
        expect(waitKindOf({ status: `idle`, attention: NO_ATTENTION })).toBeUndefined();
    });
});

describe(`reading frame after frame`, () => {
    it(`reads only the rows that changed, and hands back the same list while nothing it found did`, () => {
        const pick = jest.fn((row: { readonly found?: string }) => row.found);
        const read = everyOf(pick);
        const rows = [{ found: `a` }, {}, { found: `b` }];
        const first = read(rows);
        expect(first).toEqual([`a`, `b`]);
        pick.mockClear();

        // A streamed frame replaces only its own row: the two before it are not read again.
        const streamed = [rows[0]!, rows[1]!, {}];
        expect(read(streamed)).toEqual([`a`]);
        expect(pick).toHaveBeenCalledTimes(1);

        const prose = [rows[0]!, rows[1]!, {}, {}];
        const same = read(prose);
        expect(read([...prose])).toBe(same);
    });

    it(`keeps one reader's list stable across frames that only write prose`, () => {
        const read = pendingAsksReader();
        const once = read(ROWS, NOBODY);
        const again = read([...ROWS.slice(0, 3), { ...ROWS[3]! }], NOBODY);
        expect(again.map((ask) => ask.key)).toEqual(once.map((ask) => ask.key));
    });
});
