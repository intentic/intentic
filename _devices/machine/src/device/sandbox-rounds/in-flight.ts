// A per-slug in-flight mark that more than one flow can hold at once: a person's update and a background round, or a
// prepare and an update, can overlap on one sandbox, and the slug has to stay marked until the LAST of them ends. A plain
// Set cleared in each flow's `finally` let whichever finished first unmark the other.
export interface InFlightMarks {
    // The slugs held by at least one flow, for the readers that only ask (the rounds' `busy`, the upgrade's hold).
    readonly slugs: ReadonlySet<string>;
    // Marks `slug` until the returned release runs. Each release counts once, however often it is called, so a flow
    // that releases twice never unmarks a slug another flow still holds.
    readonly hold: (slug: string) => () => void;
}

export const inFlightMarks = (): InFlightMarks => {
    const holds = new Map<string, number>();
    const slugs = new Set<string>();
    return {
        slugs,
        hold: (slug) => {
            holds.set(slug, (holds.get(slug) ?? 0) + 1);
            slugs.add(slug);
            let released = false;
            return () => {
                if (released) {
                    return;
                }
                released = true;
                const left = (holds.get(slug) ?? 1) - 1;
                if (left > 0) {
                    holds.set(slug, left);
                    return;
                }
                holds.delete(slug);
                slugs.delete(slug);
            };
        },
    };
};
