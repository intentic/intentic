import { t } from "@intentic/ui/i18n";
import { type CommandSection, type ShellReading, lineCountOf } from "./shellOutput";

// A shell call's result in a few words for its row, from what its output turned out to be: "3 files · 170 lines",
// "5 matches · 2 files", "2 changed", "6 commits". At most two phrases, in the order the pieces came.

const lines = (count: number): string => t(`chat.toolPresentation.lines`, { count }, count);
const files = (count: number): string => t(`chat.toolPresentation.files`, { count }, count);
const matches = (count: number): string => t(`chat.toolPresentation.matches`, { count }, count);

// Every piece of one kind, worded together.
type PhraseTable = { readonly [Kind in CommandSection[`kind`]]: (sections: readonly Extract<CommandSection, { kind: Kind }>[]) => string };

const PHRASES: PhraseTable = {
    code: (slices) => {
        const total = slices.reduce((sum, slice) => sum + lineCountOf(slice.code), 0);
        return slices.length === 1 ? lines(total) : `${files(slices.length)} · ${lines(total)}`;
    },
    matches: (searches) => {
        const hits = searches.reduce((sum, search) => sum + search.hits, 0);
        const named = searches.reduce((sum, search) => sum + search.files.length, 0);
        return hits === 0 ? t(`chat.toolPresentation.noMatches`) : named > 1 ? `${matches(hits)} · ${files(named)}` : matches(hits);
    },
    paths: (listings) => files(listings.reduce((sum, listing) => sum + listing.entries.length, 0)),
    status: (statuses) => {
        const count = statuses.reduce((sum, status) => sum + status.entries.length, 0);
        return t(`chat.toolPresentation.changed`, { count }, count);
    },
    log: (logs) => {
        const count = logs.reduce((sum, log) => sum + log.entries.length, 0);
        return t(`chat.toolPresentation.commits`, { count }, count);
    },
    text: (texts) => lines(texts.reduce((sum, text) => sum + lineCountOf(text.text), 0)),
};

const phraseOf = <Kind extends CommandSection[`kind`]>(kind: Kind, sections: readonly CommandSection[]): string =>
    PHRASES[kind](sections.filter((section): section is Extract<CommandSection, { kind: Kind }> => section.kind === kind));

export const commandSummary = (shell: ShellReading): string => {
    if (shell.sections.length === 0) {
        return t(`chat.toolPresentation.noOutput`);
    }
    const kinds = [...new Set(shell.sections.map((section) => section.kind))];
    // Plain text beside a recognised piece is the noise around it (a header the command printed), not the result.
    const worded = kinds.length > 1 ? kinds.filter((kind) => kind !== `text`) : kinds;
    return worded
        .slice(0, 2)
        .map((kind) => phraseOf(kind, shell.sections))
        .join(` · `);
};
