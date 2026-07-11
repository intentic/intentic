import type { UserConfig } from "@commitlint/types";

// Conventional Commits, matching the `feat:` / `fix:` / `chore:` history across the repos. Enforced by the
// native .githooks/commit-msg hook (wired via the root `prepare` script setting core.hooksPath).
const config: UserConfig = {
    extends: [`@commitlint/config-conventional`],
    rules: {
        "type-enum": [2, `always`, [`feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`]],
    },
};

export default config;
