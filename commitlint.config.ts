import type { UserConfig } from "@commitlint/types";

// Conventional Commits, enforced by .githooks/commit-msg (root `prepare` script sets `core.hooksPath`).
const config: UserConfig = {
    extends: [`@commitlint/config-conventional`],
    rules: {
        "type-enum": [2, `always`, [`feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`]],
        // No ceiling on the body or trailers, unlike config-conventional's 100: a `Release-Note:` trailer becomes one
        // changelog bullet per line, written in the app's wrapping textarea, not a terminal. The subject stays bounded,
        // where length costs.
        "body-max-line-length": [0],
        "footer-max-line-length": [0],
        // Drops `sentence-case` only: it forces the subject's first letter lowercase, conflicting with naming it after
        // a code identifier (`StatusBadge`, `OAuth`). The other three case bans still refuse a Title Cased, PascalCase
        // or shouted subject.
        "subject-case": [2, `never`, [`start-case`, `pascal-case`, `upper-case`]],
    },
};

export default config;
