// Which pictures a turn stands for at its end, and in what order: the calls' own image entries, a delegation's
// included, a file shown twice kept once where it was last shown, and the user's own attachments left out.
import { STATE_DIR } from "@intentic/constants";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import type { ChatMessage, ChatTurn } from "../transcript";
import { attachedPaths, shotName, shotsByTurn, shotsOfTurn } from "./shots";

const SHOTS = `${STATE_DIR}/records/artifacts/browser`;

let nextId = 0;
const row = (over: Partial<ChatMessage> & Pick<ChatMessage, "role">): ChatMessage => ({ id: (nextId += 1), text: ``, ...over });

const shot = (id: string, path: string, over: Partial<TranscriptTool> = {}): TranscriptTool => ({
    id,
    name: `Browser screenshot`,
    category: `read`,
    status: `completed`,
    content: [
        { type: `text`, text: `### Result` },
        { type: `image`, path },
    ],
    ...over,
});

const turnOf = (...messages: ChatMessage[]): ChatTurn => ({ id: messages[0]!.id, messages, folded: [] });

const NONE: ReadonlySet<string> = new Set();

describe(`shotsOfTurn`, () => {
    it(`collects every picture the turn's rows carry, in the order they were shown, a delegation's own included`, () => {
        const prompt = row({ role: `user`, text: `fix the header` });
        const turn = turnOf(
            prompt,
            row({ role: `assistant`, tools: [shot(`s1`, `${SHOTS}/before.png`)] }),
            row({
                role: `assistant`,
                tools: [
                    {
                        id: `a1`,
                        name: `Agent`,
                        category: `other`,
                        status: `completed`,
                        children: [shot(`s2`, `${SHOTS}/child.png`)],
                    },
                    shot(`s3`, `${SHOTS}/after.png`),
                ],
            }),
        );
        expect(shotsOfTurn(turn, NONE)).toEqual([
            { key: `s1\n${SHOTS}/before.png`, path: `${SHOTS}/before.png`, toolId: `s1`, turnId: prompt.id },
            { key: `s2\n${SHOTS}/child.png`, path: `${SHOTS}/child.png`, toolId: `s2`, turnId: prompt.id },
            { key: `s3\n${SHOTS}/after.png`, path: `${SHOTS}/after.png`, toolId: `s3`, turnId: prompt.id },
        ]);
    });

    it(`keeps a file shown twice once, where it was last shown`, () => {
        const turn = turnOf(
            row({ role: `user`, text: `check it` }),
            row({ role: `assistant`, tools: [shot(`s1`, `${SHOTS}/page.png`), shot(`s2`, `${SHOTS}/menu.png`)] }),
            row({
                role: `assistant`,
                tools: [shot(`r1`, `${SHOTS}/page.png`, { name: `Read`, content: [{ type: `image`, path: `${SHOTS}/page.png` }] })],
            }),
        );
        expect(shotsOfTurn(turn, NONE).map((entry) => entry.toolId)).toEqual([`s2`, `r1`]);
    });

    it(`leaves out the user's own attachments, which the agent only read back`, () => {
        const upload = `${STATE_DIR}/records/artifacts/attachments/u1/mockup.png`;
        const prompt = row({ role: `user`, text: `match this`, attachments: [upload] });
        const turn = turnOf(prompt, row({ role: `assistant`, tools: [shot(`r1`, upload), shot(`s1`, `${SHOTS}/result.png`)] }));
        expect(shotsOfTurn(turn, attachedPaths(turn.messages)).map((entry) => entry.path)).toEqual([`${SHOTS}/result.png`]);
    });

    it(`finds nothing in a turn whose calls carried no picture`, () => {
        const turn = turnOf(
            row({ role: `user`, text: `run the tests` }),
            row({
                role: `assistant`,
                tools: [{ id: `b1`, name: `Bash`, category: `execute`, status: `completed`, content: [{ type: `text`, text: `ok` }] }],
            }),
        );
        expect(shotsOfTurn(turn, NONE)).toEqual([]);
    });
});

describe(`shotsByTurn`, () => {
    it(`hands an unchanged turn the very array it had, and a changed one a new array`, () => {
        const settled = turnOf(row({ role: `user`, text: `one` }), row({ role: `assistant`, tools: [shot(`s1`, `${SHOTS}/one.png`)] }));
        const live = turnOf(row({ role: `user`, text: `two` }), row({ role: `assistant`, tools: [] }));
        const before = shotsByTurn([settled, live], NONE, undefined);

        // The live turn's row is replaced by a new object carrying a new picture, as transcriptState does it.
        const grown = { ...live, messages: [live.messages[0]!, { ...live.messages[1]!, tools: [shot(`s2`, `${SHOTS}/two.png`)] }] };
        const after = shotsByTurn([{ ...settled }, grown], NONE, before);

        expect(after.get(settled.id)).toBe(before.get(settled.id)!);
        expect(after.get(live.id)?.map((entry) => entry.path)).toEqual([`${SHOTS}/two.png`]);
    });
});

describe(`shotName`, () => {
    it.each([
        [`${SHOTS}/access-wide-light.png`, `access-wide-light`],
        [`${SHOTS}/before/nav.v2.png`, `nav.v2`],
        [`shots/.hidden`, `.hidden`],
        [`README`, `README`],
    ])(`names %s as %s`, (path, name) => {
        expect(shotName(path)).toBe(name);
    });
});
