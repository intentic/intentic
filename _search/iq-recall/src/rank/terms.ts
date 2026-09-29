import { STOPWORDS } from "@intentic/base/stopwords";
import { stripInjectedPreamble } from "@intentic/constants";

// What a prompt to a coding agent says without naming a topic, on top of the shared English stopwords: the most
// frequent words of the short (<200 char) prompts in a live recall index ("go for it", "continue", "please fix it",
// "did you finish the work?"), and the pieces the tokenizer leaves of a contraction ("don't" is "don" and "t").
const PROMPT_FILLER: ReadonlySet<string> = new Set(
    [
        "please thanks thank hi hey ok okay yes no sure",
        "can could would should will let lets me my our us",
        "just also now then again so if all some there here where",
        "go ahead continue proceed next left off done finish finished work",
        "fix make better help see want need get try did",
        "don didn doesn isn ve re ll",
    ]
        .join(" ")
        .split(" "),
);

// The prompt's distinct content terms: the one tokenizer behind the FTS query and the coverage gate alike. It splits
// and folds the way the index's `unicode61 tokenchars '_$'` does (letters, digits, `_` and `$`; case and diacritics
// folded), so a term counted here is a term FTS can find. Single characters are dropped: a lone letter names nothing.
// A daemon turn preamble (the project map, the checks note) is taken off first, as ingest takes it off stored prompts:
// it is the same few hundred words on every turn, and left in it made any two prompts look alike.
export const contentTermsOf = (text: string): string[] => [
    ...new Set(
        (
            stripInjectedPreamble(text)
                .normalize("NFD")
                .replaceAll(/\p{M}/gu, "")
                .toLowerCase()
                .match(/[\p{L}\p{N}_$]+/gu) ?? []
        ).filter((term) => term.length > 1 && !STOPWORDS.has(term) && !PROMPT_FILLER.has(term)),
    ),
];

// Content terms to an FTS5 query: quoted so operators/punctuation can't break the parser, OR-ed since prompts
// paraphrase and BM25 still favors fuller matches.
export const ftsMatchOf = (terms: readonly string[]): string => terms.map((term) => `"${term}"`).join(" OR ");

// Text straight to that query; undefined when it names no topic at all.
export const ftsQueryOf = (text: string): string | undefined => {
    const terms = contentTermsOf(text);
    return terms.length === 0 ? undefined : ftsMatchOf(terms);
};
