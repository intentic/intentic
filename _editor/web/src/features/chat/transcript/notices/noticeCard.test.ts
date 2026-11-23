import { formatClock } from "@intentic/ui/format";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { attemptTimes, cardCopy, otherWords, sharedLead, wakeEntries, wakesIcon } from "./noticeCard";

// What a notice's card says past its one line: the burst one disabled account left on 2026-11-23, seven subagent
// reports for five subagents, each report re-sent with the turn it opened.

const report = (id: number, title: string, failed = true): ChatMessage => ({
    id,
    role: `notice`,
    text: `Subagent "${title}" failed.`,
    agentWords: { kind: `child`, from: `sub-${title}`, title, failed, sent: `report` },
});
const SLICE = `Optimizations slice: `;

describe(`the wakes a wall turned away`, () => {
    it(`names each sender once, counting its re-sends, with its latest word on how it ended`, () => {
        const entries = wakeEntries([report(1, `${SLICE}vectors`), report(2, `${SLICE}matrices`), report(3, `${SLICE}vectors`, false)]);
        expect(entries.map(({ label, count, state, agentId }) => ({ label, count, state, agentId }))).toEqual([
            { label: `${SLICE}vectors`, count: 2, state: `finished`, agentId: `sub-${SLICE}vectors` },
            { label: `${SLICE}matrices`, count: 1, state: `failed`, agentId: `sub-${SLICE}matrices` },
        ]);
        expect(wakesIcon(entries)).toBe(`users`);
    });

    it(`says a lead every name shares once, and nothing for one sender or names that share none`, () => {
        expect(sharedLead(wakeEntries([report(1, `${SLICE}vectors`), report(2, `${SLICE}matrices`)]))).toBe(SLICE);
        expect(sharedLead(wakeEntries([report(1, `${SLICE}vectors`)]))).toBe(``);
        expect(sharedLead(wakeEntries([report(1, `Port the parser`), report(2, `Port the lexer`)]))).toBe(``);
        // A name that is only the lead keeps it: a row is never left with no name of its own.
        expect(sharedLead(wakeEntries([report(1, `${SLICE}vectors`), report(2, `Optimizations slice:`)]))).toBe(``);
    });

    it(`counts a watch and an answered need under their own glyphs`, () => {
        const watch: ChatMessage = { id: 4, role: `notice`, text: `fired`, watchWake: { outcome: `timeout`, note: `CI run 316`, elapsed: `2h`, sent: `gave up` } };
        const entries = wakeEntries([watch]);
        expect(entries.map(({ label, state, icon }) => ({ label, state, icon }))).toEqual([{ label: `CI run 316`, state: `gaveUp`, icon: `eye` }]);
        expect(wakesIcon([...entries, ...wakeEntries([report(5, `a`)])])).toBe(`users`);
    });
});

describe(`an incident's attempts`, () => {
    const SAID = `Your organization has disabled Claude Code`;
    const at = (minute: number): number => 1_767_225_600_000 + minute * 60_000;

    it(`says every moment while they are few, the first and the last past that`, () => {
        const few = { attempts: [at(0), at(3)].map((moment) => ({ at: moment, said: SAID })), resolved: false, wakes: [] };
        expect(attemptTimes(few)).toEqual([formatClock(at(0)), formatClock(at(3))]);
        const many = { attempts: [0, 1, 2, 3, 4, 5].map((minute) => ({ at: at(minute), said: SAID })), resolved: false, wakes: [] };
        expect(attemptTimes(many)).toEqual([formatClock(at(0)), `…`, formatClock(at(5))]);
    });

    it(`quotes only the words the card does not already, and copies every attempt and sender`, () => {
        const incident = { attempts: [{ at: at(0), said: SAID }, { at: at(1), said: `Reworded.` }], resolved: false, wakes: [report(1, `a`)] };
        expect(otherWords(incident, SAID)).toEqual([`Reworded.`]);
        expect(cardCopy({ line: `Refused.`, said: SAID, incident }).split(`\n`)).toEqual([
            `Refused.`,
            SAID,
            `${formatClock(at(0))} ${SAID}`,
            `${formatClock(at(1))} Reworded.`,
            `a (failed)`,
        ]);
    });
});
