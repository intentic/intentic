import type { IconName } from "@intentic/ui";
import { readTitle } from "./workspace/commitSuggestion";

/* WHAT KIND OF WORK A SESSION IS — the category its identity tile wears, as a tint AND a glyph, on the fleet
 * board and the chat rail alike.
 *
 * The tile used to hash the conversation id into a hue, which made colour pure IDENTITY: stable, but
 * meaningless, and a column of finished sessions wore eight saturated colours that said nothing — loud enough
 * to be reported as noise. Colour that costs attention has to pay information back, so the category comes from
 * the same reading the commit box already does over these titles (readTitle): the naming pass writes
 * `<subject> · <action>`, the action word maps to a Conventional Commit type, and the type maps here. One
 * glance down a lane now groups the work — audits blue, redesigns purple, new work green, fixes red — and two
 * cards sharing a colour is a fact about the fleet rather than a hash collision.
 *
 * THE ICON SAYS WHAT THE COLOUR MEANS. A hue alone is a code the user has to have learned; the glyph on the
 * tint is the same fact in a second channel — a magnifier IS an audit, a wrench IS a fix — so the tile reads
 * on first sight, and reads at all for anyone colour can't reach. The provider mark the glyph slot used to
 * carry moved to text (the meta line's model label, the hover note): on a one-provider fleet it was the same
 * asterisk on every card — the least-discriminating fact on the surface, spending the card's one pictorial
 * slot. A card whose title reads as nothing still wears it (see IdentityTile): an unnamed draft has no
 * category yet, and "who will run it" is the most that is known.
 *
 * The hues come from the identityHue palette (the 8 the app's avatars wear, chosen to stay legible as fills
 * and tints in both schemes), assigned by connotation rather than by hash: green for growth, red for repair,
 * amber for verification. Rare types share a hue with their nearest kin — a revert is a repair, build/ci are
 * tooling — because eleven distinguishable hues is more than an eye can hold and the palette is 8 on purpose.
 *
 * `undefined` for a title the reading declines (a bare noun phrase, a question, "New chat"): the tile stays
 * neutral rather than guessing, so category ARRIVES with the naming pass — an unnamed draft is grey because
 * nothing is known about it yet, and that too is information. */
export interface SessionCategory {
    // The Conventional Commit word readTitle read — the legend the tooltip and the hover note spell out.
    readonly type: string;
    readonly hue: number;
    readonly icon: IconName;
}

const CATEGORIES: Readonly<Record<string, Omit<SessionCategory, "type">>> = {
    chore: { hue: 210, icon: `search` }, // investigation & upkeep — audit, analyze, check, review
    // ⇄ for reshaping what exists — redesign, rewrite, split, unify. Not the cycle-arrows: those rhyme with
    // the running status's arc, and a card can wear both at once.
    refactor: { hue: 280, icon: `arrows-h` },
    feat: { hue: 130, icon: `plus` }, // new work — add, design, implement, wire
    fix: { hue: 350, icon: `wrench` }, // repair — fix, debug, restore
    revert: { hue: 350, icon: `undo` }, // undoing is repair
    perf: { hue: 20, icon: `bolt` }, // speed — optimize, benchmark, cache
    test: { hue: 40, icon: `list-check` }, // verification — test, cover, verify
    build: { hue: 40, icon: `cog` }, // tooling kin of test — only ever from an explicit `build:` prefix
    ci: { hue: 40, icon: `cog` },
    docs: { hue: 160, icon: `book` }, // reference — document, describe, explain
    style: { hue: 320, icon: `palette` }, // cosmetics — polish, format, restyle
};

export const sessionCategory = (title: string | undefined): SessionCategory | undefined => {
    const type = title === undefined ? undefined : readTitle(title)?.type;
    if (type === undefined) {
        return undefined;
    }
    const entry = CATEGORIES[type];
    return entry === undefined ? undefined : { type, ...entry };
};
