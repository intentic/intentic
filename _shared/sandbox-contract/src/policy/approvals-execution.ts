// A held item is dated this far out (an ordinary scheduledAt), to catch a mis-click before it's public.
export const APPROVAL_HOLD_MS = 60_000;

// The workspace-relative directory both prompts below name, spelled once.
const APPROVALS_DIR = ".intentic/config/approvals";

// Status bookkeeping every executing turn is told, identical across kinds so the queue reads one shape back.
const WRITE_BACK = [
    `Before you act on one, set its "status" to "running" and "startedAt" to the epoch ms, so a turn that dies`,
    `here cannot do it twice. When it is done, set "status":"done" plus "finishedAt" (epoch ms) and, where`,
    `there is one, "result": the post's URL, a confirmation number, whatever a person would want to go and`,
    `look at. If it failed, set "status":"failed" plus an "error" saying what went wrong in plain words the`,
    `owner can act on, then move to the next one instead of retrying in a loop.`,
];

// What a platform's own extension says a publishing turn should know about posting there (a card's `channel.posting`,
// 2026-11-26): the Reddit rule that a comment's permalink nests the reply under that comment lived here until then.
export interface PostingNote {
    // The platform as its card names it ("Reddit").
    readonly platform: string;
    readonly note: string;
}

// Names the files directly rather than saying "go look": the daemon already decided what's due, and a re-deriving turn
// could disagree. Writes the outcome back into the same file, since that's where the queue reads it.
export const publishTurnPrompt = (posts: readonly { readonly id: string; readonly platform: string }[], notes: readonly PostingNote[] = []): string =>
    [
        `Publish these approved posts, which are due now. They live in ${APPROVALS_DIR}/, one JSON file each:`,
        ``,
        ...posts.map((post) => `- ${post.id}.json (${post.platform})`),
        ``,
        `Take them ONE AT A TIME, and for each:`,
        `1. Read the file. ${WRITE_BACK[0]}`,
        `   ${WRITE_BACK[1]}`,
        `2. Post exactly its "content": with its "title", "target" and "media", using that platform's skill.`,
        `   A "target" that is a URL means this post is a REPLY to whatever is at it: open that exact URL and`,
        `   reply where it lands, under the one comment it names if it names one.`,
        `3. ${WRITE_BACK[2]} ${WRITE_BACK[3]}`,
        `   ${WRITE_BACK[4]}`,
        ...(notes.length === 0 ? [] : [``, `What each platform's own extension adds:`, ...notes.map(({ platform, note }) => `- ${platform}: ${note}`)]),
        ``,
        `Never rewrite the content: the owner approved these exact words. Never touch a file not listed above.`,
    ].join(`\n`);

// Same discipline as a publish turn, but the work comes from the file, written by the agent that proposed it since this
// turn has none of that conversation. Approval covers exactly summary/details; anything more is failed, not improvised.
export const actionTurnPrompt = (actions: readonly { readonly id: string; readonly summary: string }[]): string =>
    [
        `Carry out these approved actions, which are due now. They live in ${APPROVALS_DIR}/, one JSON file each:`,
        ``,
        ...actions.map((action) => `- ${action.id}.json: ${action.summary}`),
        ``,
        `Take them ONE AT A TIME, and for each:`,
        `1. Read the file. ${WRITE_BACK[0]}`,
        `   ${WRITE_BACK[1]}`,
        `2. Do exactly what its "instructions" say. The owner approved what "summary" and "details" describe and`,
        `   nothing more: if carrying it out would need something they do not say, stop and fail it with that`,
        `   reason rather than improvising.`,
        `3. ${WRITE_BACK[2]} ${WRITE_BACK[3]}`,
        `   ${WRITE_BACK[4]}`,
        ``,
        `Never touch a file not listed above.`,
    ].join(`\n`);
