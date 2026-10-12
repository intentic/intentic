// Identity every daemon-authored commit carries; one source so history reads consistently across routes.
// Above the subsystems rather than inside git/, because seven of them commit as the agent (workspace, history,
// inventory, portability, conversations/land, scaffold, git) and a constant owned by one of them makes the others import it.
export const AGENT_GIT_AUTHOR = { name: "intentic", email: "agent@intentic.dev" } as const;

// The trailer naming the conversation a daemon commit was made for. Every agent commit carries the one author above, so
// without it `git log` cannot say which conversation changed what; `git log --format='%(trailers:key=Conversation-Id)'`
// reads it back. Spelled once for every subsystem that commits on a conversation's behalf.
export const CONVERSATION_TRAILER = "Conversation-Id";

// A line git reads as a trailer: `Key: value`, the key one hyphenated word.
const TRAILER_LINE = /^[A-Za-z][\w-]*: \S/;

// Joins the message's own trailer paragraph when it ends with one, since git reads only the LAST paragraph as trailers:
// a second paragraph after `Allow:` or `Test-Note:` would hide them from `git log --format=%(trailers)`, which is how
// the push check and the assertion ratchet read them. A message of one paragraph is all subject, even one shaped
// `Agent: title`, so the trailer always opens a paragraph of its own there.
export const withConversationTrailer = (message: string, conversationId: string): string => {
    const trailer = `${CONVERSATION_TRAILER}: ${conversationId}`;
    const paragraphs = message.trimEnd().split("\n\n");
    const last = paragraphs.at(-1) ?? "";
    const endsWithTrailers = paragraphs.length > 1 && last.split("\n").every((line) => TRAILER_LINE.test(line));
    return `${message.trimEnd()}${endsWithTrailers ? "\n" : "\n\n"}${trailer}`;
};
