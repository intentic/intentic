/* WHICH PARTS OF A COMMAND ARE TEXT RATHER THAN A PROGRAM, so the one tier that cannot be argued with stops
 * firing on a mention of a dangerous verb.
 *
 * WHAT THIS IS FOR, precisely, because it bounds how good it has to be. The triage catalog next door
 * (command-classes.ts) is deliberately over-inclusive: a match only means a judge should look, and a false
 * positive there costs one model call. That economy holds for every class except the hard-ruled one, where a
 * match is an interruption no policy and no verdict can waive (safety-policy.ts hardRuleClasses). So
 * `echo "rm -rf /" >> notes.md` and `rg 'rm -rf /'` raised un-waivable cards over a string being written to a
 * file and a search of the tree — the exact failure the judge redesign was built to end, surviving in the one
 * tier the judge cannot reach.
 *
 * This says where a fragment sits. A fragment inside a region below is still REPORTED (the class holds, the
 * judge still reads it, the card still marks it); it just does not trip the hard rule.
 *
 * WHICH IS WHY A REGEX-LEVEL SCANNER IS ENOUGH, and this is the design argument rather than an excuse. Both
 * ways of being wrong are cheap:
 *
 *   · MISS a region (call text a program) ⇒ one judge call. Exactly today's behaviour, which is the floor.
 *   · INVENT a region (call a program text) ⇒ the class is still reported and the judge still rules on it.
 *     Only the un-waivable tier is skipped, and the judge is the tier that reads the owner's policy.
 *
 * Precision has to be good enough to skip tier 1½, never good enough to skip tier 1. Nothing here is a
 * boundary, for the same reason nothing in command-classes.ts is: `sh -c "$CMD"` and a path assembled from a
 * variable walk past all of it. The boundaries are structural and elsewhere.
 *
 * THREE KINDS OF REGION, and each is a place a shell will not run what it holds:
 *
 *   1 A COMMENT, `#` to end of line.
 *   2 A HEREDOC BODY, the usual way an agent writes a script it is not running yet.
 *   3 A QUOTED ARGUMENT OF A VERB THAT CANNOT EXECUTE ONE — echo, printf, and the searchers. Plus a quoted
 *     commit message after -m, whatever the verb, because message text never runs.
 *
 * `sed`, `awk` and `perl` are deliberately NOT in that verb list, though they are the obvious next entries:
 * each can run a shell out of its own quoted program (`awk 'BEGIN{system("…")}'`, `perl -e`, GNU sed's `s///e`),
 * so their quoted argument is a program and calling it text would be wrong rather than merely imprecise.
 */

import type { CommandSpan } from "../policy/command-classes.js";

/* Verbs whose quoted arguments this scanner will call text. Every one of them either prints its argument or
 * matches with it, and none has a documented way to execute it. Widening this list is safe in the sense the
 * header sets out, but each entry should be able to answer "how would this run its argument?" with "it cannot". */
const QUOTING_VERBS: ReadonlySet<string> = new Set([
    "echo",
    "printf",
    "rg",
    "grep",
    "egrep",
    "fgrep",
    "ack",
    "ag",
    "ripgrep",
]);

/* A flag whose value is a message: git's -m, and the long spelling. A quoted string here is prose that reaches
 * a commit, a tag or a PR, and `git commit -m "rm -rf the old build dir"` is one of the more ordinary ways to
 * write a dangerous-looking command that is not one. Read on the WORD BEFORE a quoted argument, so it applies
 * whatever the verb is. */
const MESSAGE_FLAGS: ReadonlySet<string> = new Set(["-m", "--message", "-am", "--body", "-b"]);

// Where an unquoted word ends: whitespace, a pipeline or list operator, a redirect, a subshell paren.
const WORD_END = /[\s;|&<>()]/;

// A word that is a variable assignment prefixing a command (`FOO=bar cmd …`), skipped when looking for the verb.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/* `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`. The delimiter's quoting only decides whether the body expands, which
 * changes nothing here: an expanded body is still a body being written somewhere rather than run. */
const HEREDOC_OPEN = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

/* The heredoc bodies in a command, as spans. Found first and in their own pass, because a body is line-oriented
 * and can hold anything at all — an odd number of quotes in it would otherwise throw the word scanner out of
 * step for the rest of the command. */
const heredocBodies = (command: string): CommandSpan[] => {
    const bodies: CommandSpan[] = [];
    for (const open of command.matchAll(HEREDOC_OPEN)) {
        const indented = command.slice(open.index, open.index + 3).startsWith("<<-");
        const newline = command.indexOf("\n", open.index + open[0].length);
        if (newline === -1) {
            // `cat <<EOF` with nothing after it: an unterminated heredoc, so there is no body to mark.
            continue;
        }
        const start = newline + 1;
        const terminator = new RegExp(`^${indented ? "[ \\t]*" : ""}${open[2] as string}[ \\t]*$`, "m");
        const rest = command.slice(start);
        const end = terminator.exec(rest)?.index;
        // An unterminated body runs to the end of the command, which is what the shell would read too.
        bodies.push({ start, end: end === undefined ? command.length : start + end });
    }
    return bodies;
};

// Is this offset inside one of the spans already found? Heredoc bodies are skipped wholesale by the word scan.
const within = (spans: readonly CommandSpan[], offset: number): CommandSpan | undefined =>
    spans.find((span) => offset >= span.start && offset < span.end);

// A substitution inside double quotes, the one thing that makes a quoted argument a program again.
const EXPANDS = /\$\(|`/;

/* One quoted segment inside a word: the span covers the quotes as well as what is between them, so a region
 * handed back from here contains the whole `"rm -rf /"` and a match on any part of it reads as contained. */
interface QuotedSegment {
    readonly span: CommandSpan;
    /* Does a shell expand anything in here? `"$(rm -rf /)"` inside an echo is a real delete whose output is
     * printed, so a double-quoted segment carrying a substitution is NOT text and never becomes a region. Single
     * quotes expand nothing, so they never set this. */
    readonly expands: boolean;
}

interface ShellWord {
    readonly start: number;
    // The word with its quoting removed, which is what a verb name and a flag are compared against.
    readonly text: string;
    readonly quoted: readonly QuotedSegment[];
    // Does this word begin a simple command? True for the first word after a separator or at the start.
    readonly opensCommand: boolean;
}

// A verb by its bare name: `/bin/echo` and `./echo` are echo, and the path in front of it says nothing new.
const bareVerb = (text: string): string => text.slice(Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1);

// Every list and pipeline operator: past one of these the next word is a verb again.
const SEPARATORS = new Set(["\n", ";", "|", "&", "(", ")"]);
const BLANKS = new Set([" ", "\t", "\r"]);

/* One quoted run, from its opening quote to its closing one. An unbalanced quote takes the rest of the
 * command, which is what a shell waiting for more input would do and keeps the caller advancing. */
const readQuoted = (command: string, open: number): QuotedSegment & { readonly text: string; readonly end: number } => {
    const quote = command[open] as string;
    const close = command.indexOf(quote, open + 1);
    const end = close === -1 ? command.length : close + 1;
    const text = command.slice(open + 1, close === -1 ? command.length : close);
    return { span: { start: open, end }, expands: quote === '"' && EXPANDS.test(text), text, end };
};

/* One word, from `start` to whatever ends it, with the quoted runs inside it kept as spans. `end === start`
 * cannot happen: the caller only enters here on a character that is neither blank nor a separator. */
const readWord = (command: string, start: number): { readonly word: Omit<ShellWord, "opensCommand">; readonly end: number } => {
    const quoted: QuotedSegment[] = [];
    let text = "";
    let index = start;
    while (index < command.length && !WORD_END.test(command[index] as string)) {
        const char = command[index] as string;
        if (char === "'" || char === '"') {
            const segment = readQuoted(command, index);
            quoted.push({ span: segment.span, expands: segment.expands });
            text += segment.text;
            index = segment.end;
            continue;
        }
        if (char === "\\") {
            text += command[index + 1] ?? "";
            index += 2;
            continue;
        }
        text += char;
        index += 1;
    }
    return { word: { start, text, quoted }, end: index };
};

/* The command taken apart into words, with each word's quoted segments and whether it opens a simple command.
 * Deliberately a scanner rather than a parser: it tracks quoting and the separators that start a new command,
 * and it knows nothing about control flow, functions or expansion. Everything it gets wrong is bounded by the
 * header's argument. */
const scanWords = (command: string, skip: readonly CommandSpan[]): ShellWord[] => {
    const words: ShellWord[] = [];
    let index = 0;
    let opensCommand = true;
    while (index < command.length) {
        const skipped = within(skip, index);
        if (skipped !== undefined) {
            index = skipped.end;
            continue;
        }
        const char = command[index] as string;
        if (SEPARATORS.has(char)) {
            opensCommand = true;
            index += 1;
            continue;
        }
        if (BLANKS.has(char)) {
            index += 1;
            continue;
        }
        if (char === "#") {
            // A comment runs to the end of the line. Only reached at a word boundary, so `a#b` is one word.
            const newline = command.indexOf("\n", index);
            index = newline === -1 ? command.length : newline;
            continue;
        }
        const { word, end } = readWord(command, index);
        // A character that is neither a separator nor part of a word (a stray redirect): step over it so the
        // loop always advances.
        index = end === index ? index + 1 : end;
        if (end !== word.start) {
            words.push({ ...word, opensCommand });
            opensCommand = false;
        }
    }
    return words;
};

/* WHERE A COMMAND HOLDS TEXT RATHER THAN A PROGRAM, as spans over the command, unsorted and possibly
 * overlapping — callers ask containment questions of them rather than rendering them.
 *
 * Exported for the classifier, which asks it once per command and hands the answer to every table. */
export const inertRegions = (command: string): CommandSpan[] => {
    const bodies = heredocBodies(command);
    const regions: CommandSpan[] = [...bodies];
    const words = scanWords(command, bodies);
    // Comments are consumed by the scanner rather than reported, so they are found again here: the scan is
    // where the quoting state lives, and a `#` inside a quoted string is not a comment.
    let quotingVerb = false;
    let previous: ShellWord | undefined;
    for (const word of words) {
        if (word.opensCommand) {
            quotingVerb = QUOTING_VERBS.has(bareVerb(word.text));
            previous = undefined;
        }
        /* An env assignment in front of the verb (`LC_ALL=C grep …`) is not the verb. Re-read the next word as
         * one instead of giving up on the command. */
        if (word.opensCommand && ASSIGNMENT.test(word.text) && word.quoted.length === 0) {
            quotingVerb = false;
            previous = undefined;
            continue;
        }
        const afterMessageFlag = previous !== undefined && MESSAGE_FLAGS.has(previous.text);
        if (quotingVerb || afterMessageFlag) {
            regions.push(...word.quoted.filter((segment) => !segment.expands).map((segment) => segment.span));
        }
        previous = word;
    }
    regions.push(...commentRegions(command, bodies));
    return regions;
};

/* Comments, on the same scan discipline as the words: a `#` only opens one where a word could have started, so
 * `sha#1` is not a comment, and a quoted `"# …"` is not one either.
 *
 * Its own walk rather than a by-product of scanWords, because the two want different things from a quote — the
 * word scan needs what is INSIDE one, this needs only to be past it. Sharing readQuoted keeps them agreeing on
 * where one ends, which is the only fact they both depend on. */
const commentRegions = (command: string, skip: readonly CommandSpan[]): CommandSpan[] => {
    const comments: CommandSpan[] = [];
    let index = 0;
    while (index < command.length) {
        const skipped = within(skip, index);
        if (skipped !== undefined) {
            index = skipped.end;
            continue;
        }
        const char = command[index] as string;
        if (char === "'" || char === '"') {
            index = readQuoted(command, index).end;
            continue;
        }
        if (char === "\\") {
            index += 2;
            continue;
        }
        // A word boundary in front is what makes it a comment rather than part of a word.
        if (char === "#" && (index === 0 || WORD_END.test(command[index - 1] as string))) {
            const newline = command.indexOf("\n", index);
            const end = newline === -1 ? command.length : newline;
            comments.push({ start: index, end });
            index = end;
            continue;
        }
        index += 1;
    }
    return comments;
};

/* Is this fragment somewhere a shell would RUN it? The question the hard rule asks of every span triage matched.
 *
 * JUDGED ON WHERE THE FRAGMENT STARTS, not on whether a region contains the whole of it, and the difference is
 * not a relaxation — it is the only reading that answers the question asked. Every pattern in the catalog is
 * written to BEGIN at the verb (`rm`, `docker volume rm`, `mkfs`, `git push`), so the span's first character is
 * where the dangerous thing was found. Whether the match then ran on past a closing quote says something about
 * the regex, not about the command: `rm`'s own parser reads to the end of the invocation and `>` is not a
 * terminator, so `echo "rm -rf /" >> notes.md` produces a span covering `rm -rf /" >> notes.md`. Requiring
 * containment made that command live — which is exactly the card this whole change exists to stop raising.
 *
 * The conservative direction is preserved where it matters: a fragment whose verb sits OUTSIDE every region is
 * live no matter what it runs into afterwards, so `echo "tidying" && rm -rf /` and `rm -rf "$(cat list)" # ok`
 * both stay live. */
export const isLive = (span: CommandSpan, regions: readonly CommandSpan[]): boolean =>
    !regions.some((region) => span.start >= region.start && span.start < region.end);
