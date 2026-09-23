import { t } from "@intentic/ui/i18n";
import { describe, expect, it } from "bun:test";
import { buildIdeas, buildPrompt } from "../buildIdeas";
import { boardScreen, boardStarters } from "./firstScreen";

// Pins what an empty board shows: the first run until anything was ever started, the cleared board once it was and the
// lanes are bare, the lanes whenever the archive is open; and which starters a workspace earns, in which order.

describe(`which screen the board draws`, () => {
    it(`asks for a first task until anything was started, and says the board was cleared once it was`, () => {
        expect(boardScreen(false, 0, false)).toBe(`first`);
        // An untouched draft is on the board without anything having started.
        expect(boardScreen(false, 1, false)).toBe(`first`);
        expect(boardScreen(true, 0, false)).toBe(`cleared`);
        expect(boardScreen(true, 3, false)).toBe(`lanes`);
    });

    it(`always draws the lanes while the archive stands in Finished`, () => {
        expect([boardScreen(false, 0, true), boardScreen(true, 0, true)]).toEqual([`lanes`, `lanes`]);
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
