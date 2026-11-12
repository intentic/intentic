import { bareBranch } from "../../../../models/fleet/presses/agentMenu";
import { shortBranch } from "./sessionChip";

describe(`bareBranch`, () => {
    it(`hands back the conversation id, which is the handle every tool takes`, () => {
        expect(bareBranch(`agent/sleek-arrow-uzgj`)).toBe(`sleek-arrow-uzgj`);
    });

    it(`never elides — this is the string that gets pasted, not the one that gets glanced at`, () => {
        const long = `ci-fix-32458072655-mt2mi4z21`;
        expect(bareBranch(`agent/${long}`)).toBe(long);
    });

    it(`leaves a branch that does not carry the prefix untouched`, () => {
        expect(bareBranch(`main`)).toBe(`main`);
    });
});

describe(`shortBranch`, () => {
    it(`drops the prefix every session branch shares`, () => {
        expect(shortBranch(`agent/otter-k7mq`)).toBe(`otter-k7mq`);
    });

    it(`leaves a drawn name and a subagent's alone — the budget is set at them on purpose`, () => {
        expect(shortBranch(`agent/salmon-yqa5`)).toBe(`salmon-yqa5`);
        expect(shortBranch(`agent/sub-walnut-h87h`)).toBe(`sub-walnut-h87h`);
    });

    it(`cuts a fix agent's name early, keeping its attempt in sight`, () => {
        expect(shortBranch(`agent/fix-intentic-jqzy27q_5`)).toBe(`fix-inte…zy27q_5`);
    });

    it(`elides the MIDDLE of a name raised from an outside id, keeping both ends`, () => {
        const shown = shortBranch(`agent/ci-fix-32458072655-mt2mi4z21`);
        expect(shown).toBe(`ci-fix-3…2mi4z21`);
        // The head says what it is for and the tail is what makes it unique — both survive.
        expect(shown.startsWith(`ci-fix`)).toBe(true);
        expect(shown.endsWith(`2mi4z21`)).toBe(true);
    });

    it(`keeps two long branches that differ only at the end apart, which tail truncation would not`, () => {
        const one = shortBranch(`agent/ci-fix-32458072655-aaaaaaaaa`);
        const two = shortBranch(`agent/ci-fix-32458072655-bbbbbbbbb`);
        expect(one).not.toBe(two);
    });

    it(`never exceeds the budget once the ellipsis is counted`, () => {
        expect(shortBranch(`agent/${`x`.repeat(200)}`)).toHaveLength(16);
    });

    it(`leaves a name that does not carry the prefix untouched`, () => {
        expect(shortBranch(`main`)).toBe(`main`);
    });
});
