import type { LanguageRegistration } from "shiki/core";

/* Minimal TextMate grammar for gitignore-style files (.gitignore, .dockerignore, .prettierignore, …) —
 * @shikijs/langs ships no ignore grammar. Scopes are limited to ones light-plus/dark-plus actually color:
 * comment (green), keyword.control (purple "!" negation), constant.character.escape (wildcards/ranges). */
const gitignore: LanguageRegistration = {
    name: `gitignore`,
    scopeName: `source.gitignore`,
    patterns: [
        { match: `^\\s*#.*$`, name: `comment.line.number-sign.gitignore` },
        { match: `^\\s*!`, name: `keyword.control.negation.gitignore` },
        { match: `\\*\\*|\\*|\\?`, name: `constant.character.escape.wildcard.gitignore` },
        { match: `\\[[^\\]]*\\]`, name: `constant.character.escape.range.gitignore` },
    ],
    repository: {},
};

export default [gitignore];
