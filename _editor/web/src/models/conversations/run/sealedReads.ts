// WHETHER A CONVERSATION IS SEALED FROM THIS READER (agent-status/sealView.ts), as the board's roster says, for the reads
// that must never be made of one: its transcript and its live run (useChat-sessions.ts hydrate), whose gate stands in its
// chat's place instead (SealGate). The fleet sits above conversations and registers its reading here
// (useAgents-registry.ts); until it has, nothing is sealed, which is what a sandbox without private conversations says.

let sealed: (conversationId: string) => boolean = () => false;

/** The fleet's reading of the roster, registered once as it loads. */
export const readSealsWith = (read: (conversationId: string) => boolean): void => {
    sealed = read;
};

/** Whether this conversation's words are sealed from the reader, so nothing of them is asked for. */
export const sealedFrom = (conversationId: string): boolean => sealed(conversationId);
