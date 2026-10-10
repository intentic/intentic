import { t } from "@intentic/ui/i18n";
import { buildIdeas, buildPrompt } from "../buildIdeas";

// What an empty board shows: ALWAYS THE LANES. A first board used to be a centred hero that turned into three columns the
// moment anything was sent, so a new reader met the board twice and learned the first one was a placeholder. Now a
// first run draws the lanes it will keep, with the first agent's slot in Active where its card will arrive, each empty
// lane saying what will land in it, and starters read off the workspace that fill the one composer (the chat's) and
// never send. A board that was cleared is the same lanes, empty, with the archive's door in Finished's header.

// The first run is nothing ever started here; the archive always opens onto the lanes it fills, never onto a slot.
export const firstRun = (started: boolean, archive: boolean): boolean => !started && !archive;

export interface Starter {
    readonly label: string;
    readonly prompt: string;
}

// Concrete sentences to press, not feature names, as a ladder: understand, then a small safe change. With nothing to point
// an agent at, only building something, which needs no code; bringing code in is the workspace pane's offer, not this.
export const boardStarters = (repos: number, changes: number): readonly Starter[] => {
    if (repos === 0 && changes === 0) {
        return buildIdeas().map((example) => ({ label: example.label, prompt: buildPrompt(example.idea) }));
    }
    return [
        // Uncommitted work leads when it exists, as the most urgent thing on a workspace that has any.
        ...(changes > 0 ? [{ label: t(`agents.agentsView.reviewMyChanges`), prompt: t(`agents.agentsView.reviewMyUncommittedChanges`) }] : []),
        { label: t(`agents.agentsView.explainCodebase`), prompt: t(`agents.agentsView.explainCodebaseWhatDoes`) },
        { label: t(`agents.agentsView.findSomethingToImprove`), prompt: t(`agents.agentsView.suggestThreeSmallSafe`) },
    ];
};
