// The contract's cap on a conversation's title (AgentTurn.title): every door that names a conversation from what
// arrived (a wake's message, an issue, a webchat visitor, a CI failure, a fix attempt) clamps to it. Here, below all of
// them, so none imports another to read one number.
export const TITLE_MAX = 80;

// A bare name identifies a file, project or topic, but says nothing about the work. Shared by the naming pass and
// registry so an old automatic label can be repaired and the replacement cannot be another bare label.
export const isBareConversationTitle = (title: string): boolean => {
    const words = title.trim().replace(/^(["'`])(.*)\1$/, "$2").trim().split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
    return words.length < 2 || words.every((word) => /[/\\.]/u.test(word));
};
