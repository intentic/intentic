import { t } from "@intentic/ui/i18n";
import { buildIdeas, buildPrompt } from "../buildIdeas";

// What an empty board shows: the first run asks for a task, with starters read off the workspace that fill the one
// composer (the chat's) and never send; a board that was cleared needs only its way back to the archive.

export type BoardScreen = `first` | `cleared` | `lanes`;

// The archive always opens onto the lanes, or an archive behind an empty board would be a dead end with no door; the
// first run is nothing ever started, the cleared board nothing on it now.
export const boardScreen = (started: boolean, total: number, archive: boolean): BoardScreen => {
    if (archive) {
        return `lanes`;
    }
    if (!started) {
        return `first`;
    }
    return total === 0 ? `cleared` : `lanes`;
};

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
