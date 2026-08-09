/* HOW AN APPROVED POST GETS SENT — the shared half, written once because the daemon acts on it, the app draws
 * it, and the two have to agree on the same seconds.
 *
 * THERE IS NO PUBLISHER AUTOMATION ANY MORE, and its absence is the design. Publishing used to be a scheduled
 * automation: a cron waking every few minutes, running a shell guard over the drafts directory, almost always
 * finding nothing — a job whose entire job was to ask "yet?" forever. It also made the approve button
 * conditional on a row in a list nobody had asked for: delete the automation and approvals silently went
 * nowhere, with the button still there and still saying yes. The daemon owns publishing now
 * (drafts-publisher.ts). It knows the moment a draft comes due because it is the process that wrote the draft,
 * so it sleeps until exactly then and costs nothing in between.
 *
 * APPROVAL IS NOT "SEND NOW", IT IS "SEND UNLESS I STOP YOU". A post is public and permanent the instant it
 * lands, and the gap between realising and clicking is about two seconds — so an approved draft carrying no
 * date of its own is dated HOLD into the future, and the queue counts it down in the open. The hold is stored
 * as an ordinary scheduledAt rather than as a new state, which is what keeps it honest: it survives a restart,
 * it reads as one number in the same place a scheduled post's date is already read, and calling it off is the
 * "put it back in review" click that was there before any of this.
 *
 * A MINUTE, because that is the whole width of the decision: long enough to catch the wrong word you see the
 * moment the row stops being a form, short enough that approving something still feels like sending it. */
export const APPROVAL_HOLD_MS = 60_000;

/* WHO CAN BE SENT BY CODE ALONE. A connector reached through a real API with a stored credential is a request
 * the daemon can make itself — no model, no browser, no turn — and it either got a 200 or it did not. A
 * connector that IS a logged-in browser session (reddit, x) has no such door: posting there means driving a
 * page whose markup moves under you, past dialogs and rate screens nobody can enumerate in advance, which is
 * precisely the work an agent turn exists to absorb.
 *
 * So the split follows what the platform actually offers rather than what would be cheaper, and it is stated
 * here rather than guessed at a call site — because being wrong in the optimistic direction means a post that
 * silently never goes out. A platform absent from this set is published by an agent turn, which always works
 * and merely costs more. */
export const DIRECT_PUBLISH_PLATFORMS: ReadonlySet<string> = new Set(["discord"]);

/* WHAT THE PUBLISH TURN IS TOLD, for the drafts no API can carry. It NAMES the drafts rather than saying "go
 * and look": the daemon has already decided what is due, and a turn that re-derives that decision can disagree
 * with it — sending something the owner pulled back a second ago, or skipping something it judged not ready.
 * The turn's job is the part only it can do, which is working the platform's own UI.
 *
 * It still writes the outcome back into the file, because the file is where the queue reads it, and a post
 * that went out without saying so is a post the owner sends twice. */
export const publishTurnPrompt = (drafts: readonly { readonly id: string; readonly platform: string }[]): string =>
    [
        `Publish these approved post drafts, which are due now. They live in .intentic/drafts/, one JSON file each:`,
        ``,
        ...drafts.map((draft) => `- ${draft.id}.json (${draft.platform})`),
        ``,
        `Take them ONE AT A TIME, and for each:`,
        `1. Read the file. Set "status":"posting" BEFORE you act, so a turn that dies here cannot double-post.`,
        `2. Post exactly its "content" — with its "title", "target" and "media" — using that platform's skill.`,
        `   A "target" that is a URL means this draft is a REPLY to whatever is at it: open that exact URL and`,
        `   reply where it lands. On reddit a comment permalink (.../comments/<post>/<slug>/<comment>/) has to`,
        `   nest under that comment rather than becoming a new top-level comment on the thread.`,
        `3. Set "status":"posted" plus "postedAt" (epoch ms) and, when the platform gives you one, "postedUrl".`,
        `   If it failed, set "status":"failed" plus an "error" saying what went wrong in plain words the owner`,
        `   can act on, then move to the next draft instead of retrying in a loop.`,
        ``,
        `Never rewrite the content — the owner approved these exact words. Never touch a draft not listed above.`,
    ].join(`\n`);
