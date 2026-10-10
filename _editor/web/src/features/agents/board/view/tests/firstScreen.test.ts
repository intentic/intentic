import { t } from "@intentic/ui/i18n";
import { buildIdeas, buildPrompt } from "../../buildIdeas";
import { boardStarters, firstRun } from "../firstScreen";

// Pins what an empty board shows: always the lanes, with a first run's slot and lane lines until anything was ever
// started, and never on the archive; and which starters a workspace earns, in which order.

describe(`when the board is on its first run`, () => {
    it(`is a first run until anything was started, and a cleared board after`, () => {
        expect(firstRun(false, false)).toBe(true);
        expect(firstRun(true, false)).toBe(false);
    });

    it(`is never a first run while the archive stands in Finished`, () => {
        expect([firstRun(false, true), firstRun(true, true)]).toEqual([false, false]);
    });
});

describe(`what the first screen offers to press`, () => {
    it(`offers only building something on a workspace with nothing to point an agent at`, () => {
        expect(boardStarters(0, 0)).toEqual(buildIdeas().map((idea) => ({ label: idea.label, prompt: buildPrompt(idea.idea) })));
    });

    it(`offers understanding, then a small change, once there is a repository`, () => {
        expect(boardStarters(1, 0)).toEqual([
            { label: t(`agents.agentsView.explainCodebase`), prompt: t(`agents.agentsView.explainCodebaseWhatDoes`) },
            { label: t(`agents.agentsView.findSomethingToImprove`), prompt: t(`agents.agentsView.suggestThreeSmallSafe`) },
        ]);
    });

    it(`leads with the uncommitted work when there is some, repository or not`, () => {
        expect(boardStarters(0, 2)).toEqual([
            { label: t(`agents.agentsView.reviewMyChanges`), prompt: t(`agents.agentsView.reviewMyUncommittedChanges`) },
            ...boardStarters(1, 0),
        ]);
        expect(boardStarters(3, 1)).toEqual(boardStarters(0, 2));
    });
});
