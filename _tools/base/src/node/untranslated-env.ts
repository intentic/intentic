// THE ENVIRONMENT FOR A PROGRAM WHOSE OUTPUT IS READ, NOT ONLY SHOWN. git, coreutils, ssh and glibc's strerror translate
// their messages through gettext (`Unable to create … File exists` and `CONFLICT (content)` both have Polish
// translations), while the code that classifies a refusal reads English. This pins gettext's C locale for messages
// alone: LC_MESSAGES=C, LANGUAGE dropped (gettext ignores it under C anyway), and an LC_ALL, which would override
// LC_MESSAGES, spread onto every other category instead, so text encoding, collation and dates stay what they were.
// LC_ALL=C would also be English, but it turns a UTF-8 caller's character handling into ASCII.
const OTHER_LOCALE_CATEGORIES = [
    "LC_CTYPE",
    "LC_NUMERIC",
    "LC_TIME",
    "LC_COLLATE",
    "LC_MONETARY",
    "LC_PAPER",
    "LC_NAME",
    "LC_ADDRESS",
    "LC_TELEPHONE",
    "LC_MEASUREMENT",
    "LC_IDENTIFICATION",
] as const;

export const untranslatedEnv = (env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv => {
    const { LC_ALL: all, LANGUAGE: _ignoredUnderC, ...rest } = env;
    const spread = all === undefined || all === "" ? {} : Object.fromEntries(OTHER_LOCALE_CATEGORIES.map((category) => [category, all]));
    return { ...rest, ...spread, LC_MESSAGES: "C" };
};
