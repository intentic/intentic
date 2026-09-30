// Titles two or more rows of one list share. A first prompt retried on another provider opens a second chat with the
// same words, and each such row then needs a fact beyond its title (its model, when it last moved) to be told apart.
// Untitled rows (a conversation's null title) are not twins: they are named by their own draft, or as new.
export const twinsOf = (titles: Iterable<string | null | undefined>): ReadonlySet<string> => {
    const seen = new Set<string>();
    const twins = new Set<string>();
    for (const title of titles) {
        if (title !== null && title !== undefined) {
            (seen.has(title) ? twins : seen).add(title);
        }
    }
    return twins;
};
