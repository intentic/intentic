import type { Beat } from "../../turn";
import { act, closing, type HomeStory, opening, say, text } from "./story";

// THE RESEARCH SANDBOX'S HOME: the owner asks how the shop's prices stand against three rivals, and the agent sends one
// subagent to each shop at once, watches them read, then writes the brief and answers with the table.

export const BRIEF_PATH = `research/linen-prices-october.md`;

export const BRIEF = `# Linen prices, October

Our three bestsellers against the three shops our customers mention most, read from each shop's own site today.

| Bestseller | Acme | Oak & Linen | Hearth Co | Studio North |
| --- | --- | --- | --- | --- |
| Linen apron | €38 | €42 | €34 | €39 |
| Tea towel set | €24 | €26 | €21 | €26 |
| Bed sheet set | €129 | €149 | €115 | €135 |

## What changed since August

- **Hearth Co cut about 10% across the range** on 21 October, and now undercuts us on all three.
- **Studio North raised tea towels by €2.** Nothing else moved.
- **Oak & Linen held its prices** and added free shipping over €100.

## What it means

We are still cheaper than Oak & Linen and Studio North everywhere. Hearth Co is the one to watch: their sheets are €14 under ours.
`;

interface Rival {
    readonly id: string;
    readonly shop: string;
    readonly tools: readonly string[];
    readonly summary: string;
}

const RIVALS: readonly Rival[] = [
    {
        id: `tc_research_oak`,
        shop: `Oak & Linen`,
        tools: [`Browser navigate`, `Browser snapshot`, `Browser click`],
        summary: `No price changes since August. Free shipping over €100 is new.`,
    },
    {
        id: `tc_research_hearth`,
        shop: `Hearth Co`,
        tools: [`Browser navigate`, `Browser snapshot`, `Browser navigate`, `Browser snapshot`],
        summary: `Cut about 10% across the range on 21 October: apron €34, towels €21, sheets €115.`,
    },
    {
        id: `tc_research_north`,
        shop: `Studio North`,
        tools: [`Browser navigate`, `Browser snapshot`],
        summary: `Tea towels up €2 to €26. Apron and sheets unchanged.`,
    },
];

const task = (rival: Rival): string => `Read ${rival.shop}'s prices`;

// All three start together, report as they work, and finish one after another: the order a reader sees them land in.
const fanOut = (): Beat[] => [
    ...RIVALS.flatMap((rival, index): Beat[] => [
        {
            after: index === 0 ? 500 : 250,
            event: { kind: `tool_call`, id: rival.id, name: `Agent`, category: `other`, status: `in_progress`, target: task(rival), locations: [] },
        },
        {
            after: 50,
            event: {
                kind: `subagent`,
                id: rival.id,
                subagentKind: `subagent`,
                description: task(rival),
                model: `claude-sonnet-5`,
            },
        },
    ]),
    ...[0, 1, 2, 3].flatMap((round): Beat[] =>
        RIVALS.filter((rival) => round < rival.tools.length).map((rival) => ({
            after: 600,
            event: { kind: `subagent_update`, id: rival.id, status: `running`, toolUses: round + 1, lastTool: rival.tools[round] },
        })),
    ),
    ...[2, 0, 1].flatMap((index): Beat[] => {
        const rival = RIVALS[index];
        if (rival === undefined) {
            return [];
        }
        return [
            {
                after: 900,
                event: { kind: `subagent_update`, id: rival.id, status: `completed`, toolUses: rival.tools.length, tokens: 18_400 + index * 2_100, summary: rival.summary },
            },
            { after: 50, event: { kind: `tool_call_update`, id: rival.id, status: `completed`, content: text(rival.summary) } },
        ];
    }),
];

export const RESEARCH: HomeStory = {
    history: [
        { role: `user`, text: `How are we doing against the other linen shops?` },
        {
            role: `assistant`,
            text: `I last compared prices in August, and at least two of the shops have changed things since. So that comparison is out of date.`,
        },
    ],
    prompt: `Compare our bestsellers with Oak & Linen, Hearth Co and Studio North, and write it up as a one-page brief.`,
    beats: [
        opening(),
        ...say(1_800, `I'll send one agent to each shop so they read in parallel, then put what they find side by side.`),
        ...fanOut(),
        ...act(500, {
            id: `tc_research_ours`,
            name: `Read`,
            category: `read`,
            target: `catalog/bestsellers.csv`,
            path: `catalog/bestsellers.csv`,
            takes: 600,
            result: text(`Linen apron €38 · Tea towel set €24 · Bed sheet set €129`),
        }),
        ...act(400, {
            id: `tc_research_brief`,
            name: `Write`,
            category: `edit`,
            target: BRIEF_PATH,
            path: BRIEF_PATH,
            takes: 1_200,
            result: [{ type: `diff`, path: BRIEF_PATH, newText: BRIEF }],
        }),
        ...say(
            500,
            `**Hearth Co cut prices by about 10%** last week, and now undercuts us on all three bestsellers. Oak & Linen and Studio North barely moved.\n\nWant me to check all three every Monday and tell you when something changes?`,
        ),
        ...closing({ kind: `usage`, account: `ada@acme.dev`, costUsd: 0.94, inputTokens: 96_300, outputTokens: 6_800 }),
    ],
};
