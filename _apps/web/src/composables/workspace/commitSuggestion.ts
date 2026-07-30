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

/* A title that is already written as a Conventional Commits subject — the user's own `fix: …` prompt, or a
 * session the title-summary pass renamed that way. Split rather than re-prefixed: its type is better than any
 * verb table's guess.
 *
 * CASE-INSENSITIVE, because title.ts capitalizes every title it derives (`fix: Codex agents…` is stored as
 * `Fix: Codex agents…`), so a lowercase-only match never fired on the one shape it was written for and filed the
 * user's own subject under a second type: `feat: fix: Codex agents…`.
 *
 * Which is why the type is then CHECKED rather than trusted. `Note: …`, `Warning: …` and `TODO: …` have the shape
 * of a prefixed subject and none of its meaning; read as types they produce a line commitlint's `type-enum`
 * refuses, so they fall through to the verb reading below and are treated as the prose they are. */
const PREFIXED = /^([a-z]+)((?:\([^)]*\))?!?):\s+(\S.*)$/i;
const TYPES = new Set([`build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`]);
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

/* THE FIRST CHARACTER IS THE WHOLE RULE, and it is not a matter of taste: commitlint's `subject-case`
 * (config-conventional, `never` sentence-case) reduces to `upperFirst(subject) === subject`, so a subject that
 * OPENS with a capital is sentence case whatever the rest of it looks like, and the commit-msg hook throws the
 * commit back. `fix: Codex agents broken transcript loading` is refused; the same line with a lowercase `c`
 * commits. Sentence case is a TITLE's convention (title.ts capitalizes for exactly that reason) and a subject's
 * is the opposite, so every reading below undoes it — doing it in only some of them is what filed a line the
 * hook would not take.
 *
 * CASING THAT MEANS SOMETHING is not sentence case and is not flattened: `GitHub`, `ChatPanel.vue` and `CI/CD`
 * are different words in lower case, and the guard for them mirrors title.ts's `capitalized`. They get
 * commitlint's own escape hatch instead — it deletes backticked and quoted spans before it looks at the subject,
 * naming proper nouns as the reason — so the name survives verbatim and the line no longer opens with a letter
 * the rule can call a capital. */
const MEANINGFUL = /[A-Z/._\\]/;
// The opening word without whatever punctuation follows it: `GitLab,` is a name and a comma, and only the name
// belongs inside the backticks.
const LEAD = /^[\w./\\-]+/;

const subjectCased = (text: string): string => {
    const [first = ``] = LEAD.exec(text) ?? [];
    if (!/^[A-Z]/.test(first)) {
        return text;
    }
    if (MEANINGFUL.test(first.slice(1))) {
        return `\`${first}\`${text.slice(first.length)}`;
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
    if (prefixed !== null && TYPES.has(prefixed[1]!.toLowerCase())) {
        // The type is lowercased, the scope and the `!` kept as written — commitlint's `type-case` is
        // `lower-case` and it has nothing to say about the rest.
        return { type: `${prefixed[1]!.toLowerCase()}${prefixed[2]!}`, subject: subjectCased(prefixed[3]!) };
    }
    const [lead = ``] = clean.split(` `, 1);
    const verb = VERBS.get(lead.toLowerCase());
    if (verb === undefined) {
        return { type: DEFAULT_TYPE, subject: subjectCased(clean) };
    }
    if (!verb.drop) {
        return { type: verb.type, subject: subjectCased(clean) };
    }
    const rest = clean.slice(lead.length).trim().replace(ARTICLE, ``);
    // `Fix.` / `Refactor` — the verb was the entire title, so dropping it would leave nothing. The type alone
    // says as much as that title did.
    return { type: verb.type, subject: subjectCased(rest === `` ? clean : rest) };
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
