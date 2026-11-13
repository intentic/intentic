// The contract's cap on a conversation's title (AgentTurn.title): every door that names a conversation from what
// arrived (a wake's message, an issue, a webchat visitor, a CI failure, a fix attempt) clamps to it. Here, below all of
// them, so none imports another to read one number.
export const TITLE_MAX = 80;

// A bare name identifies a file, project or topic, but says nothing about the work. Shared by the naming pass and
// registry so an old automatic label can be repaired and the replacement cannot be another bare label.
// Titles follow the language of the opening message (title-namer.ts), and Chinese, Japanese and Thai put no spaces
// between words, so a run of a few of their letters counts as words of its own rather than one bare token.
const UNSPACED_LETTER = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/gu;
const UNSPACED_PHRASE = 4;

export const isBareConversationTitle = (title: string): boolean => {
    const words = title.trim().replace(/^(["'`])(.*)\1$/, "$2").trim().split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
    const unspaced = (title.match(UNSPACED_LETTER) ?? []).length;
    return (words.length < 2 && unspaced < UNSPACED_PHRASE) || words.every((word) => /[/\\.]/u.test(word));
};
