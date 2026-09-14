/* How much of a message becomes a card's name. */
const PREVIEW_CHARS = 48;

export const draftPreview = (text: string): string | undefined => {
    // One line: a pasted paragraph is still a card title, and its newlines would otherwise wrap the lane.
    const line = text.trim().replace(/\s+/gu, ` `);
    if (line === ``) {
        return undefined;
    }
    if (line.length <= PREVIEW_CHARS) {
        return line;
    }
    const cut = line.slice(0, PREVIEW_CHARS);
    const space = cut.lastIndexOf(` `);
    // A word boundary in the back half only: cutting at the first space of a long word would leave a title of
    // two letters, which says less than the clipped word does.
    return `${(space > PREVIEW_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};
