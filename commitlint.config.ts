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
    },
};

export default config;
