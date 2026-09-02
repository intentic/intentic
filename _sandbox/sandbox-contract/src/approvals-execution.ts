/* HOW AN APPROVED THING GETS DONE, the shared half, written once because the daemon acts on it, the app draws
 * it, and the two have to agree on the same seconds.
 *
 * THERE IS NO EXECUTOR AUTOMATION, and its absence is the design. Publishing used to be a scheduled automation:
 * a cron waking every few minutes, running a shell guard over the queue directory, almost always finding
 * nothing, a job whose entire job was to ask "yet?" forever. It also made the approve button conditional on a
 * row in a list nobody had asked for: delete the automation and approvals silently went nowhere, with the
 * button still there and still saying yes. The daemon owns execution (approvals-executor.ts). It knows the
 * moment an item comes due because it is the process that wrote it, so it sleeps until exactly then and costs
 * nothing in between.
 *
 * APPROVAL IS NOT "DO IT NOW", IT IS "DO IT UNLESS I STOP YOU". A post is public and permanent the instant it
 * lands, a booking is charged, and the gap between realising and clicking is about two seconds, so an approved
 * item carrying no date of its own is dated HOLD into the future, and the queue counts it down in the open. The
 * hold is stored as an ordinary scheduledAt rather than as a new state, which is what keeps it honest: it
 * survives a restart, it reads as one number in the same place a scheduled item's date is already read, and
 * calling it off is the "put it back in review" click that was there before any of this.
 *
 * A MINUTE, because that is the whole width of the decision: long enough to catch the wrong word you see the
 * moment the row stops being a form, short enough that approving something still feels like doing it. */
export const APPROVAL_HOLD_MS = 60_000;

/* WHO CAN BE SENT BY CODE ALONE. A connector reached through a real API with a stored credential is a request
 * the daemon can make itself, no model, no browser, no turn, and it either got a 200 or it did not. A
 * connector that IS a logged-in browser session (reddit, x) has no such door: posting there means driving a
 * page whose markup moves under you, past dialogs and rate screens nobody can enumerate in advance, which is
 * precisely the work an agent turn exists to absorb.
 *
 * So the split follows what the platform actually offers rather than what would be cheaper, and it is stated
 * here rather than guessed at a call site, because being wrong in the optimistic direction means a post that
 * silently never goes out. A platform absent from this set is published by an agent turn, which always works
 * and merely costs more. */
export const DIRECT_PUBLISH_PLATFORMS: ReadonlySet<string> = new Set(["discord"]);

// The workspace-relative directory both prompts below name, spelled once.
const APPROVALS_DIR = ".intentic/config/approvals";

// The status bookkeeping every executing turn is told, identical across kinds so the file the queue reads back
// is the same shape whoever wrote it.
const WRITE_BACK = [
    `Before you act on one, set its "status" to "running" and "startedAt" to the epoch ms, so a turn that dies`,
    `here cannot do it twice. When it is done, set "status":"done" plus "finishedAt" (epoch ms) and, where`,
    `there is one, "result": the post's URL, a confirmation number, whatever a person would want to go and`,
    `look at. If it failed, set "status":"failed" plus an "error" saying what went wrong in plain words the`,
    `owner can act on, then move to the next one instead of retrying in a loop.`,
];

/* WHAT THE PUBLISH TURN IS TOLD, for the posts no API can carry. It NAMES the files rather than saying "go and
 * look": the daemon has already decided what is due, and a turn that re-derives that decision can disagree
 * with it, sending something the owner pulled back a second ago, or skipping something it judged not ready.
 * The turn's job is the part only it can do, which is working the platform's own UI.
 *
 * It still writes the outcome back into the file, because the file is where the queue reads it, and a post
 * that went out without saying so is a post the owner sends twice. */
export const publishTurnPrompt = (posts: readonly { readonly id: string; readonly platform: string }[]): string =>
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
        `   reply where it lands. On reddit a comment permalink (.../comments/<post>/<slug>/<comment>/) has to`,
        `   nest under that comment rather than becoming a new top-level comment on the thread.`,
        `3. ${WRITE_BACK[2]} ${WRITE_BACK[3]}`,
        `   ${WRITE_BACK[4]}`,
        ``,
        `Never rewrite the content: the owner approved these exact words. Never touch a file not listed above.`,
    ].join(`\n`);

/* WHAT THE ACTION TURN IS TOLD. The same discipline as a publish turn, named files, status written before and
 * after, with the work itself coming from the file: the agent that proposed the action wrote its own
 * instructions for this moment, knowing this turn would arrive with none of the conversation. The owner's yes
 * covered what `summary` and `details` said, so the instructions are carried out as written and nothing beyond
 * them is done; an action that turns out to need more than it said is failed with that sentence, not
 * improvised. */
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
