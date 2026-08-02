import { readTitle } from "./workspace/commitSuggestion";

/* WHAT KIND OF WORK A SESSION IS, worn as a hue — the colour on a session card's identity tile, on the fleet
 * board and the chat rail alike.
 *
 * The tile used to hash the conversation id into a hue, which made colour pure IDENTITY: stable, but
 * meaningless, and a column of finished sessions wore eight saturated colours that said nothing — loud enough
 * to be reported as noise. Colour that costs attention has to pay information back, so the hue now comes from
 * the same reading the commit box already does over these titles (readTitle): the naming pass writes
 * `<subject> · <action>`, the action word maps to a Conventional Commit type, and the type maps here. One
 * glance down a lane now groups the work — audits blue, redesigns purple, new work green, fixes red — and two
 * cards sharing a colour is a fact about the fleet rather than a hash collision.
 *
 * The hues come from the identityHue palette (the 8 the app's avatars wear, chosen to stay legible as fills
 * and tints in both schemes), assigned by connotation rather than by hash: green for growth, red for repair,
 * amber for verification. Rare types share a hue with their nearest kin — a revert is a repair, build/ci are
 * tooling — because eleven distinguishable hues is more than an eye can hold and the palette is 8 on purpose.
 *
 * `undefined` for a title the reading declines (a bare noun phrase, a question, "New chat"): the tile stays
 * neutral rather than guessing, so colour ARRIVES with the naming pass — an unnamed draft is grey because
 * nothing is known about it yet, and that too is information. */
const TYPE_HUES: Readonly<Record<string, number>> = {
    chore: 210, // investigation & upkeep — audit, analyze, check, review: the commonest kind, the calmest hue
    refactor: 280, // reshaping what exists — redesign, rewrite, split, unify
    feat: 130, // new work — add, design, implement, wire
    fix: 350, // repair — fix, debug, restore
    revert: 350, // undoing is repair
    perf: 20, // speed — optimize, benchmark, cache
    test: 40, // verification — test, cover, verify
    build: 40, // tooling kin of test — only ever from an explicit `build:` prefix
    ci: 40,
    docs: 160, // reference — document, describe, explain
    style: 320, // cosmetics — polish, format, restyle
};

// The type word itself, for the surfaces that say the category as well as wear it (a tile's tooltip, a hover
// preview's note) — colour without a legend is a code the user has to break.
export const categoryLabel = (title: string | undefined): string | undefined => (title === undefined ? undefined : readTitle(title)?.type);

export const categoryHue = (title: string | undefined): number | undefined => {
    const type = categoryLabel(title);
    return type === undefined ? undefined : TYPE_HUES[type];
};
