/* A SESSION TITLE, READ AS A COMMIT SUBJECT — what the Changes panel files into the commit box when the user
 * clicks a session in its "From" legend.
 *
 * Those titles are derived from the opening prompt by the same rule everything else names a conversation with
 * (sandbox-contract's title.ts): an imperative line about the work, cut to one bounded sentence. That is
 * already most of a commit subject — "Fix cascading workspace tree truncation markers" — so a user typing a
 * message above a legend that says exactly what the change was is retyping what they can already read. One
 * click moves it across, in the shape a subject line wants.
 *
 * A CHOSEN LINE, NOT A GUESS ABOUT THE DIFF. It arrives only when asked for, it is one keystroke from being
 * overwritten, and it costs nothing — which is what separates it from the AI autofill next to it: that one
 * reads the actual diff on a model, so it is worth a click and a quota, and it stays the way to get a message
 * about what the code does rather than what the ask was.
 *
 * The prefix is PRESCRIBED here, and deliberately unlike the daemon's draft (which infers the house style from
 * the repo's own recent subjects and knows nothing of Conventional Commits). Nothing on this side of the wire
 * can see a repo's log without a fetch nobody asked for, and a bare title is not a subject — it is a sentence
 * with a capital letter. Guessing `feat:`/`fix:` from the title's own verb is wrong only in the cases the user
 * corrects by typing over it, and the panel's convention is that the model's word wins whenever the user asks
 * for it. */

// A title that is already written as a Conventional Commits subject — the user's own `fix: …` prompt, or a
// session the title-summary pass renamed that way. Split rather than re-prefixed: its type is better than any
// verb table's guess.
const PREFIXED = /^([a-z]+(?:\([^)]*\))?!?):\s+(\S.*)$/;
// Dropped along with a verb that named the type: `Fix the tree truncation` reads as `fix: tree truncation`, and
// keeping the article would leave `fix: the tree truncation` — a subject that starts by pointing at something.
const ARTICLE = /^(?:the|a|an)\s+/i;

/* WHICH TYPE A TITLE'S OPENING VERB MEANS, and whether that verb survives into the subject. Two tables because
 * the answer differs per verb, and the difference is the whole readability of the line:
 *   - a verb that NAMES its type is redundant after the prefix — `fix: fix cascading markers` says it twice, so
 *     the verb goes and the object becomes the subject.
 *   - every other verb IS the subject's action, because the prefix is not a verb. `feat:` cannot carry "add",
 *     so `feat: add icons to chat tabs` keeps it and `feat: icons to chat tabs` would lose what happened.
 * A curated list, exactly like title.ts's IMPERATIVE (which is where these verbs come from): English hands out
 * noun/verb ambiguity too freely for anything cleverer, and an unrecognized lead word simply gets the default
 * below rather than a wrong guess about its grammar. */
const NAMES_TYPE: Readonly<Record<string, readonly string[]>> = {
    fix: [`fix`, `repair`, `correct`, `resolve`, `patch`, `debug`],
    refactor: [`refactor`, `rework`, `restructure`],
    docs: [`document`, `docs`],
    test: [`test`],
    revert: [`revert`],
    style: [`restyle`],
};

const IMPLIES_TYPE: Readonly<Record<string, readonly string[]>> = {
    fix: [`prevent`, `stop`, `guard`, `harden`, `tighten`, `ensure`, `restore`],
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
        `clean`,
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
    perf: [`optimize`, `optimise`, `speed`, `cache`, `reduce`, `profile`],
    docs: [`describe`, `explain`],
    test: [`cover`, `verify`],
    style: [`polish`, `format`, `prettify`, `tweak`],
    chore: [
        `adjust`,
        `analyze`,
        `analyse`,
        `audit`,
        `avoid`,
        `bump`,
        `check`,
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

interface TitleVerb {
    readonly type: string;
    // The verb named the type, so it is dropped rather than repeated after the prefix.
    readonly drop: boolean;
}

const VERBS = new Map<string, TitleVerb>([
    ...Object.entries(NAMES_TYPE).flatMap(([type, verbs]) => verbs.map((verb): [string, TitleVerb] => [verb, { type, drop: true }])),
    ...Object.entries(IMPLIES_TYPE).flatMap(([type, verbs]) => verbs.map((verb): [string, TitleVerb] => [verb, { type, drop: false }])),
]);

// A title whose lead word is in neither table describes work with no verb this can read — a noun phrase, a
// question, a pasted line. `feat` is the type for "new work" and the whole title stays: the guess that can be
// wrong is the prefix, and the prefix is the cheap half to correct.
const DEFAULT_TYPE = `feat`;

// Sentence case is a TITLE's convention (title.ts capitalizes for exactly that reason) and a subject's is the
// opposite, so it is undone — but only for plainly lowercase prose. `GitLab`, `useAgents` and `API` mean
// something by their casing, and the mirror-image guard to title.ts's `capitalized` is what leaves them alone.
const decapitalized = (text: string): string => {
    const [first = ``] = text.split(` `, 1);
    if (!/^[A-Z]/.test(first) || /[A-Z/.\\]/.test(first.slice(1))) {
        return text;
    }
    return `${first[0]!.toLowerCase()}${text.slice(1)}`;
};

// A title read as one commit type plus one subject fragment. Undefined for a title with nothing in it.
const readTitle = (title: string): { readonly type: string; readonly subject: string } | undefined => {
    // A trailing full stop belongs to a sentence, not a subject; a question mark carries the tone the title
    // meant and stays.
    const clean = title.replaceAll(/\s+/g, ` `).trim().replace(/\.+$/, ``).trim();
    if (clean === ``) {
        return undefined;
    }
    const prefixed = PREFIXED.exec(clean);
    if (prefixed !== null) {
        return { type: prefixed[1]!, subject: prefixed[2]! };
    }
    const [lead = ``] = clean.split(` `, 1);
    const verb = VERBS.get(lead.toLowerCase());
    if (verb === undefined) {
        return { type: DEFAULT_TYPE, subject: decapitalized(clean) };
    }
    if (!verb.drop) {
        return { type: verb.type, subject: decapitalized(clean) };
    }
    const rest = clean.slice(lead.length).trim().replace(ARTICLE, ``);
    // `Fix.` / `Refactor` — the verb was the entire title, so dropping it would leave nothing. The type alone
    // says as much as that title did.
    return { type: verb.type, subject: rest === `` ? decapitalized(clean) : rest };
};

/* One subject line from one or more session titles.
 *
 * It takes a LIST because a commit box is a single line and a commit can carry several sessions' work, so the
 * titles are joined rather than reduced to the first: a message that names one of three sessions is wrong about
 * two thirds of itself. Nothing is dropped to keep the line short — the box is one edit away, and silently
 * omitting a session is worse than a long line that doesn't. The legend's click passes exactly one title; the
 * plural shape is what makes "and this one too" a one-line change rather than a rewrite.
 *
 * The type comes from the FIRST title: types don't merge (a commit that fixes and features is both), and the
 * leading session — the busiest, in the order the legend is already read in — is the best single answer. */
export const conventionalSubject = (titles: readonly string[]): string | undefined => {
    const parts = titles.map(readTitle).filter((part) => part !== undefined);
    // Two sessions named the same thing describe it once — in the FIRST one's spelling, since that is the
    // busiest session and the type already came from it.
    const subjects = [...new Map(parts.toReversed().map((part) => [part.subject.toLowerCase(), part.subject])).values()].toReversed();
    if (subjects.length === 0) {
        return undefined;
    }
    return `${parts[0]!.type}: ${subjects.join(`, `)}`;
};
