/* A SESSION TITLE, READ AS A COMMIT SUBJECT — the FALLBACK the Changes panel files into the commit box when a
 * session in its "From" legend has no sentence of its own.
 *
 * It used to be the only reading. A landing now carries a subject drafted from its own diff (the daemon's
 * landed-subject.ts), which beats this outright for the reason spelled out there: a title names the ASK, and
 * the ask and the change drift apart in any conversation that turns. What is left for this is everything that
 * cannot produce one — no AI account connected, a draft that failed, a landing older than the feature — where
 * the title is still the best thing on screen and retyping it is still waste.
 *
 * They arrive in two shapes, because two things write them. The quick model writes `<subject> · <action>`
 * (agent/title-namer.ts), which is a commit subject with its type sitting at the far end. Everything else —
 * the pre-model derivation, a plan heading, a rename — writes an imperative line, which is a commit subject
 * with its type sitting at the near end. Both are read below, tail first: only the model's shape can put a
 * bare action word after a separator, so finding one is unambiguous, and a title without one falls through to
 * the leading-verb reading that has always handled the rest.
 *
 * A CHOSEN LINE, NOT A GUESS ABOUT THE DIFF. It arrives only when asked for, it is one keystroke from being
 * overwritten, and it costs nothing — no model, no quota, no wait, which is what keeps it the answer on a
 * sandbox with nothing connected. The sparkle button next to it stays the way to describe a commit this cannot
 * see at all: everything the user staged themselves, and everything they have edited since a land.
 *
 * The prefix is PRESCRIBED here, and deliberately unlike the daemon's draft (which infers the house style from
 * the repo's own recent subjects and knows nothing of Conventional Commits). Nothing on this side of the wire
 * can see a repo's log without a fetch nobody asked for, and a bare title is not a subject — it is a sentence
 * with a capital letter. Guessing `feat:`/`fix:` from the title's own verb is wrong only in the cases the user
 * corrects by typing over it, and the panel's convention is that the model's word wins whenever the user asks
 * for it. */

/* A title that is already written as a Conventional Commits subject — the user's own `fix: …` prompt, or a
 * session the naming pass renamed that way. Split rather than re-prefixed: its type is better than any
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
    fix: [`prevent`, `stop`, `guard`, `harden`, `tighten`, `ensure`, `restore`, `diagnose`],
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
// question, a pasted line. Reading it reports NO type rather than guessing one, because the two consumers
// disagree about what a guess is worth: the commit box defaults to `feat` (the prefix is the cheap half to
// correct), while the category tint declines to colour — a wrong hue would teach the palette to lie.
const DEFAULT_TYPE = `feat`;

/* The action tag on a model-written title: ` · fix`, ` · remove`, ` · logging`. Anchored to the end and limited
 * to one word, which is the whole of what makes it distinguishable from a middle dot used as punctuation —
 * `Auth · session · token refresh` is a path, and only its last segment is a candidate. */
const ACTION_TAG = /\s+·\s+([\w-]+)$/;

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

/* The same sentence case undone for a fragment that is about to stop being the start of the line — the head of
 * a tagged title, once its action tag has moved in front of it. `Agent card line counts · add` must not read
 * `add Agent card line counts`: that capital was the title's own convention and means nothing here.
 *
 * No backticks, and that is the whole difference from subjectCased: those exist to get a name PAST commitlint's
 * first-character rule, and nothing this returns is at the first character any more. A name simply stays as
 * written. */
const uncapitalized = (text: string): string => {
    const [first = ``] = LEAD.exec(text) ?? [];
    if (!/^[A-Z]/.test(first) || MEANINGFUL.test(first.slice(1))) {
        return text;
    }
    return `${first[0]!.toLowerCase()}${text.slice(1)}`;
};

/* A title read as one commit type plus one subject fragment. Undefined for a title with nothing in it; a
 * present reading with `type: undefined` for one whose kind could not be read (no prefix, no tag, no known
 * verb). EXPORTED for the second reader of the same convention: the session cards colour their identity tile
 * by this type (sessionCategory), so the commit box and the tile can never read one title as two kinds of work. */
export const readTitle = (title: string): { readonly type: string | undefined; readonly subject: string } | undefined => {
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
    /* `Sandbox freezes · fix` — the model's shape, and the same two tables read from the other end. The tag
     * moves to the FRONT of the subject rather than staying where it is, because a subject is a sentence about
     * the change and English puts its verb first: `refactor: remove resume-with-claude`, not `refactor:
     * resume-with-claude remove`. A tag that NAMES its type is dropped instead, exactly as a leading verb is.
     *
     * A tag in neither table (`logging`, `benchmark`) is not a verb at all — it is the last noun of the title,
     * which the separator was only ever formatting. It stays where the model put it, joined back as prose. */
    const tagged = ACTION_TAG.exec(clean);
    // An empty head (`· fix`) is a tag and nothing else: there is no subject to move it in front of, so the
    // title falls through and is read as the one word it is.
    const head = tagged === null ? `` : clean.slice(0, tagged.index).trim().replace(ARTICLE, ``);
    if (tagged !== null && head !== ``) {
        const tag = tagged[1]!;
        const tagVerb = VERBS.get(tag.toLowerCase());
        if (tagVerb === undefined) {
            return { type: undefined, subject: subjectCased(`${head} ${tag}`) };
        }
        return { type: tagVerb.type, subject: tagVerb.drop ? subjectCased(head) : `${tag} ${uncapitalized(head)}` };
    }
    const [lead = ``] = clean.split(` `, 1);
    const verb = VERBS.get(lead.toLowerCase());
    if (verb === undefined) {
        return { type: undefined, subject: subjectCased(clean) };
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
    return `${parts[0]!.type ?? DEFAULT_TYPE}: ${subjects.join(`, `)}`;
};
