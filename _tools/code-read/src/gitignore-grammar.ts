import type { LanguageRegistration } from "shiki/core";

/* Minimal TextMate grammar for gitignore-style files (.gitignore, .dockerignore, .prettierignore, …). */
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
