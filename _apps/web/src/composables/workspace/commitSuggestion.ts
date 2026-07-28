import type { GitDiffSide, RepoChanges } from "@intentic-app/api-contract";
import { ALL_SIDES, summarizeOrigins } from "./changeOrigins";

/* THE COMMIT BOX'S FREE FIRST DRAFT — the session titles already on screen, read as a commit subject.
 *
 * The Changes panel's "From" row names, per agent, the session whose work is sitting in the tree, and those
 * titles are derived from the opening prompt by the same rule everything else names a conversation with
 * (sandbox-contract's title.ts): an imperative line about the work, cut to one bounded sentence. That is
 * already most of a commit subject — "Fix cascading workspace tree truncation markers" — so an empty commit box
 * above a legend that says exactly what the change was is a blank the user fills in by retyping what they can
 * already read. This turns it into the box's starting text.
 *
 * A SUGGESTION, NOT A MESSAGE. It only ever fills a box the user has nothing of their own in (see
 * commitMessage.ts), it is one keystroke from being overwritten, and it costs nothing — which is what separates
 * it from the AI autofill next to it: that one reads the actual diff on a model, so it is worth a click and a
 * quota, and it stays the way to get a message about what the code does rather than what the ask was.
 *
 * IT DESCRIBES WHAT THE COMMIT WILL RECORD, the one rule this whole family of files shares (see the daemon's
 * commit-message.ts). With something staged, the titles come from the STAGED files' origins and nothing else —
 * a commit records the index, and naming it after an agent whose work is sitting unstaged would put the wrong
 * subject over the wrong diff. With nothing staged the button is "Commit all", which sweeps every side, so
 * every side's origins count.
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

/* One subject line from the titles of every session whose work this commit will record, newest-busiest first
 * (the order the legend is already read in).
 *
 * Several sessions share ONE commit and therefore one subject, so their titles are joined rather than reduced
 * to the first: a commit that carries three sessions' work and names one of them is a message that is wrong
 * about two thirds of itself. Nothing is dropped to keep the line short for the same reason — the box is one
 * edit away, and a suggestion that silently omits a session is worse than a long one that doesn't.
 *
 * The type comes from the FIRST title, the session with the most files in the tree: types don't merge (a commit
 * that fixes and features is both), and the busiest session is the best single answer available. */
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

// The index alone — what a plain Commit records. Its counterpart is the legend's ALL_SIDES, which is also what
// "Commit all" sweeps, so the two shapes of the button need no third list.
const STAGED: readonly GitDiffSide[] = [`staged`];

/* The suggestion itself: the subject the commit box falls back to, or undefined when there is nothing to
 * suggest from — no agent landed anything here, or the ones that did have no title in this browser's fleet
 * mirror yet. An untitled origin is skipped rather than named: the legend's "Agent 4f2a1c" placeholder is an
 * id, and an id is not a description of a change.
 *
 * `titleOf` resolves an agent id through the fleet roster the panel already mirrors, and is passed in rather
 * than read here so this stays a pure function of the review set (the daemon sends ids, never titles).
 */
export const suggestCommitMessage = (repos: readonly RepoChanges[], titleOf: (id: string) => string | undefined): string | undefined => {
    const staged = repos.some((repo) => repo.staged.length > 0);
    const { agents } = summarizeOrigins(repos, staged ? STAGED : ALL_SIDES);
    return conventionalSubject(agents.flatMap((agent) => titleOf(agent.id) ?? []));
};
