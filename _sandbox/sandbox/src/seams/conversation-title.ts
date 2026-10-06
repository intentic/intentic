// The contract's cap on a conversation's title (AgentTurn.title): every door that names a conversation from what
// arrived (a wake's message, an issue, a webchat visitor, a CI failure, a fix attempt) clamps to it. Here, below all of
// them, so none imports another to read one number.
export const TITLE_MAX = 80;
