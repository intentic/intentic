import type { UserConfig } from "@commitlint/types";

// Conventional Commits, matching the `feat:` / `fix:` / `chore:` history across the repos. Enforced by the
// native .githooks/commit-msg hook (wired via the root `prepare` script setting core.hooksPath).
const config: UserConfig = {
    extends: [`@commitlint/config-conventional`],
    rules: {
        "type-enum": [2, `always`, [`feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`]],
        /* NO LINE CEILING ON THE BODY OR THE TRAILERS, both of which config-conventional caps at 100.
         *
         * The trailer cap is the one that had to go. A `Release-Note:` / `Breaking-Note:` value is harvested
         * back out line by line (`git log --format='%(trailers:key=Release-Note,valueonly)'`, see
         * _tools/scripts/release/publish-github.sh) and each line becomes ONE changelog bullet, so a note wrapped to
         * fit the cap ships as two half-sentences, and one sentence describing what a user will notice runs
         * past 100 characters often enough that the cap was refusing good notes rather than long ones.
         *
         * The body cap goes with it: these messages are written in the app's commit box, a textarea that wraps,
         * not in a 72-column terminal editor, and a paragraph that reads perfectly there was being rejected for
         * its shape. The SUBJECT stays bounded (config-conventional's header-max-length, untouched), that is
         * the line read in lists, where length actually costs something.
         */
        "body-max-line-length": [0],
        "footer-max-line-length": [0],
        /* A SUBJECT MAY LEAD WITH A NAME FROM THE CODE, which is what dropping `sentence-case` from this list
         * buys and the only thing it drops.
         *
         * config-conventional bans four case shapes here, and three of them are real: a Title Cased subject, a
         * shout, and one PascalCase blob in place of a sentence are all a message written in the wrong register.
         * `sentence-case` is not a shape at all. @commitlint/ensure implements it as
         * `upperFirst(subject) === subject`, so it means exactly one thing: THE FIRST LETTER MUST BE LOWERCASE.
         *
         * That fights the house rule one layer up. Both the drafter's prompt and this repo's own history ask a
         * subject to NAME THINGS, spelled as the code spells them (_sandbox/sandbox/src/git/ops/commit-message.ts),
         * and `StatusBadge`, `API`, `OAuth`, `ESLint` are spelled with a capital or they are spelled wrong. So a
         * subject that obeyed the naming rule was refused by the case rule, and the only ways out were to mangle
         * the identifier (`statusBadge`, `eSLint`) or to bounce the message back at whoever wrote it. Neither is
         * worth a rule whose entire content is the case of one character.
         *
         * The other three stay, and still bite: `feat: Sandbox Access View Redesign`, `fix: STOP THE REORDERING`
         * and `fix: StopTheReordering` are all refused exactly as before. */
        "subject-case": [2, `never`, [`start-case`, `pascal-case`, `upper-case`]],
    },
};

export default config;
