import type { IconName } from "@intentic/ui";

/* WHAT KIND OF WORK A SESSION IS — the category its identity tile wears, as a tint AND a glyph, on the fleet
 * board and the chat rail alike.
 *
 * The tile used to hash the conversation id into a hue, which made colour pure IDENTITY: stable, but
 * meaningless, and a column of finished sessions wore eight saturated colours that said nothing — loud enough
 * to be reported as noise. Colour that costs attention has to pay information back, so the category is read out
 * of the title instead (titleType below): the naming pass writes `<subject> · <action>`, the action word maps
 * to a Conventional Commit type, and the type maps here. One glance down a lane now groups the work — audits
 * blue, redesigns purple, new work green, fixes red — and two cards sharing a colour is a fact about the fleet
 * rather than a hash collision.
 *
 * THE READING LIVES HERE NOW, and it used to live next to a second consumer. The commit box read the same
 * titles through the same tables to GUESS a commit subject when nothing better existed — `Review panel · audit`
 * filed as `chore: review panel audit` — and that guess is gone: a commit message is written from the diff or
 * it is not written at all. A tint is the one thing a title can still honestly supply, because a tint is a
 * claim about the ASK and the ask is exactly what a title names.
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
    // The Conventional Commit word titleType read — the legend the tooltip and the hover note spell out.
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

/* A title already written as a Conventional Commits subject — the user's own `fix: …` prompt, or a session a
 * rename spelled that way. Its own word beats any verb table's reading of it.
 *
 * CASE-INSENSITIVE, because title.ts capitalizes every title it derives (`fix: Codex agents…` is stored as
 * `Fix: Codex agents…`), so a lowercase-only match never fired on the one shape it was written for.
 *
 * Which is why the word is then CHECKED against the table rather than trusted. `Note: …`, `Warning: …` and
 * `TODO: …` have the shape of a prefixed subject and none of its meaning, so they fall through to the verb
 * reading below and are treated as the prose they are. The scope and the `!` are read but discarded — a
 * `feat(web)!:` title is the same KIND of work as a `feat:` one, and a tint has no room to say more. */
const PREFIXED = /^([a-z]+)(?:\([^)]*\))?!?:\s+\S/i;
// Dropped along with a leading verb, so `Fix the tree truncation` and `Fix tree truncation` read alike.
const ARTICLE = /^(?:the|a|an)\s+/i;

/* WHICH TYPE A TITLE'S VERB MEANS. A curated list rather than anything cleverer: English hands out noun/verb
 * ambiguity too freely, and an unrecognized word gets NO category rather than a wrong one — see the header, a
 * neutral tile is information. The words are the ones the naming pass actually writes (agent/title-namer.ts
 * asks for exactly one action word) plus the imperatives title.ts derives when no model has named a session. */
const VERBS: Readonly<Record<string, readonly string[]>> = {
    fix: [`fix`, `repair`, `correct`, `resolve`, `patch`, `debug`, `prevent`, `stop`, `guard`, `harden`, `tighten`, `ensure`, `restore`, `diagnose`],
    feat: [
        `add`,
        `allow`,
        `automate`,
        `bootstrap`,
        `change`,
        `complete`,
        `continue`,
        `create`,
        `design`,
        `disable`,
        `draft`,
        `enable`,
        `expose`,
        `extend`,
        `finish`,
        `generate`,
        `give`,
        `handle`,
        `hide`,
        `implement`,
        `improve`,
        `integrate`,
        `introduce`,
        `localize`,
        `localise`,
        `make`,
        `name`,
        `parse`,
        `persist`,
        `render`,
        `scaffold`,
        `show`,
        `support`,
        `surface`,
        `teach`,
        `translate`,
        `validate`,
        `wire`,
        `write`,
        `build`,
        `connect`,
    ],
    refactor: [
        `refactor`,
        `rework`,
        `restructure`,
        `clean`,
        `cleanup`,
        `consolidate`,
        `convert`,
        `dedupe`,
        `deduplicate`,
        `delete`,
        `drop`,
        `extract`,
        `group`,
        `inline`,
        `merge`,
        `move`,
        `order`,
        `port`,
        `remove`,
        `rename`,
        `replace`,
        `rethink`,
        `rewrite`,
        `redesign`,
        `simplify`,
        `sort`,
        `split`,
        `swap`,
        `turn`,
        `unify`,
        `wrap`,
    ],
    perf: [`optimize`, `optimise`, `speed`, `cache`, `reduce`, `profile`, `benchmark`],
    docs: [`document`, `docs`, `describe`, `explain`],
    test: [`test`, `cover`, `verify`],
    style: [`restyle`, `polish`, `format`, `prettify`, `tweak`],
    revert: [`revert`],
    chore: [
        `adjust`,
        `analyze`,
        `analyse`,
        `audit`,
        `avoid`,
        `bump`,
        `check`,
        `compare`,
        `configure`,
        `deploy`,
        `figure`,
        `find`,
        `install`,
        `investigate`,
        `measure`,
        `migrate`,
        `pin`,
        `prepare`,
        `propose`,
        `rebase`,
        `release`,
        `review`,
        `run`,
        `ship`,
        `try`,
        `update`,
        `upgrade`,
    ],
};

const TYPE_OF_VERB = new Map(Object.entries(VERBS).flatMap(([type, verbs]) => verbs.map((verb): [string, string] => [verb, type])));

/* The action tag on a model-written title: ` · fix`, ` · remove`, ` · logging`. Anchored to the end and limited
 * to one word, which is the whole of what makes it distinguishable from a middle dot used as punctuation —
 * `Auth · session · token refresh` is a path, and only its last segment is a candidate. A tag in no verb table
 * (`logging`, `view`) is not an action at all; it is the title's last noun, and the reading declines. */
const ACTION_TAG = /\s+·\s+([\w-]+)$/;

// The kind of work a title names, or undefined when it names none. Tail first: only the naming pass's shape can
// put a bare action word after a separator, so finding one is unambiguous, and a title without one falls
// through to the leading-verb reading that handles everything a model never touched.
const titleType = (title: string): string | undefined => {
    const clean = title.replaceAll(/\s+/gu, ` `).trim().replace(/\.+$/, ``).trim();
    if (clean === ``) {
        return undefined;
    }
    const prefixed = PREFIXED.exec(clean);
    if (prefixed !== null && prefixed[1]!.toLowerCase() in CATEGORIES) {
        return prefixed[1]!.toLowerCase();
    }
    const tagged = ACTION_TAG.exec(clean);
    // An empty head (`· fix`) is a tag and nothing else — there is no title in front of it to categorize, so it
    // falls through and is read as the one word it is.
    if (tagged !== null && clean.slice(0, tagged.index).trim() !== ``) {
        return TYPE_OF_VERB.get(tagged[1]!.toLowerCase());
    }
    const [lead = ``] = clean.replace(ARTICLE, ``).split(` `, 1);
    return TYPE_OF_VERB.get(lead.toLowerCase());
};

export const sessionCategory = (title: string | undefined): SessionCategory | undefined => {
    const type = title === undefined ? undefined : titleType(title);
    if (type === undefined) {
        return undefined;
    }
    const entry = CATEGORIES[type];
    return entry === undefined ? undefined : { type, ...entry };
};
