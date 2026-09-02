import { ApprovalSchema, type ApprovalSummary } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { writeLoadedSkill } from "../settings/loaded-skills.js";
import { jsonDir } from "../store/json-dir.js";
import { stateRelPath } from "../workspace/state-paths.js";

// The workspace-relative home the skill text below teaches the agent, the table's spelling, so the prompt
// can never name a directory the store stopped reading.
const APPROVALS_DIR = stateRelPath(".intentic/config/approvals/");

// The approvals queue (<workspace>/.intentic/config/approvals/<id>.json, one file per item): the AGENT creates them
// (taught by APPROVALS_SKILL below), the daemon edits/deletes them for the owner. Per-file, never a shared
// manifest like automations.json, because the two writers would race a read-modify-write (see json-dir.ts,
// which owns that cycle and the trust boundary around agent-written names). No secrets live here.

export interface ApprovalsStore {
    // Parsed items (scheduledAt ascending) plus the filenames that failed to parse, an agent typo, or a kind
    // this daemon does not know, must be visible in the UI, not an item that silently never runs.
    readonly list: () => Promise<{ approvals: ApprovalSummary[]; invalid: string[] }>;
    // Upsert by id, approve/edit/retry are all a rewrite of the whole file.
    readonly upsert: (approval: ApprovalSummary) => Promise<void>;
    // True when an item of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

// A per-file JSON store, used in production at <workspace>/.intentic/config/approvals/.
export const fileApprovalsStore = (dir: string): ApprovalsStore => {
    const files = jsonDir(dir, (raw) => ApprovalSchema.safeParse(raw).data);
    return {
        list: async () => {
            const { entries, invalid } = await files.list();
            // scheduledAt is optional; undated items sort last (a plain subtraction would be NaN).
            return {
                approvals: entries.toSorted((a, b) => (a.scheduledAt ?? Number.POSITIVE_INFINITY) - (b.scheduledAt ?? Number.POSITIVE_INFINITY)),
                invalid,
            };
        },
        upsert: ({ id, ...approval }) => files.write(id, approval),
        remove: files.remove,
    };
};

// How the agent learns the file format, the same loaded-skills mechanism every capability connector uses.
// Triggered by description, so a user prompt like "prepare social media posts" or "book the hotel" routes
// here without any automation change.
const APPROVALS_SKILL = `---
name: approvals
description: Prepare things for owner approval instead of doing them: posts to publish, and any action you should not take unasked (a booking, a payment, a message sent as the owner, a deletion). Write one JSON file per item into ${APPROVALS_DIR}/. Use whenever asked to prepare, draft, propose or schedule a post (X, Reddit, YouTube, Discord, …), and whenever you are about to do something outward-facing or irreversible on the owner's behalf.
---

# Approvals (the owner's yes)

Anything that acts in the owner's name, or cannot be undone, is NEVER done directly: write an approval file
instead. The owner approves it in the app, which starts a short countdown they can still stop, and the
daemon then carries it out when it comes due: sending a post itself where a platform has an API, or waking
you with the exact files to act on. One JSON file per item: ${APPROVALS_DIR}/<id>.json (id: letters,
digits, dashes; it names the item in the UI). Two kinds, told apart by "kind":

## kind: "post", something to publish

{
  "kind": "post",
  "platform": "x",
  "actsAs": "social-poster",
  "content": "exact post text",
  "title": "…",
  "target": "r/webdev",
  "media": ["${APPROVALS_DIR}/media/chart.png"],
  "scheduledAt": 1767950400000,
  "status": "proposed",
  "createdAt": 1767800000000
}

Only "kind", "platform" and "content" are required; everything else is optional: except "actsAs", which
every platform that posts through a logged-in browser needs (see below).
- platform: the skill that will post it, "x", "reddit", "youtube", "discord", …
- title (a new reddit post or a YouTube upload needs one) and target, where on the platform this goes.
- A target that is a URL makes the post a REPLY to whatever is at it: a thread, a video, a tweet, or ONE
  PERSON'S COMMENT (on reddit that is the comment's own permalink, .../comments/<post>/<slug>/<comment>/). The
  publisher opens exactly this URL and replies where it lands, so the difference between the thread's address
  and a comment's decides whether the reply nests under that person or arrives addressed to nobody.
- A reply publishes no title on any platform, so "title" on one is your note to the OWNER about why this
  reply: the app shows it as a note under the post rather than as a headline.
- media: workspace-relative files; put them under ${APPROVALS_DIR}/media/.

## kind: "action", anything else you should not do unasked

{
  "kind": "action",
  "summary": "Book the Hotel Adlon, Berlin, 12–14 March, one double room, €420",
  "details": "**Hotel Adlon Kempinski**, Unter den Linden 77\\n- Check-in 12 March, check-out 14 March\\n- Double room, breakfast included: €420 total\\n- Paid with the card on the booking.com account",
  "instructions": "Open booking.com as the persona, search Hotel Adlon Berlin for 12–14 March, pick the double room with breakfast at €420, complete the booking with the saved card, and put the confirmation number in \\"result\\".",
  "actsAs": "travel",
  "status": "proposed",
  "createdAt": 1767800000000
}

- summary: ONE LINE saying what will happen, the row the owner reads and the confirm dialog's item.
- details: Markdown, the specifics a yes is being asked for: the dates and the price, the amount and the
  account, the exact message and who receives it. Everything they would need to see to say no.
- instructions: what to do once approved, written for the FRESH TURN that will do it, which has none of this
  conversation: name files, ids, accounts and steps; never "do what we discussed". Do exactly what the owner
  approved and nothing beyond it.

## Both kinds

- actsAs: WHOSE NAME THIS ACTS UNDER, the id of a persona in .intentic/config/personas.json, one that holds
  an account for the site involved. Read that file and pick; if none of them fits, say so to the owner
  rather than guessing. Execution happens with nobody watching, and a turn that names no persona is given NO
  logged-in account at all: a browser-published post without this is failed unsent, with that reason written
  into it, and an action without it runs with no accounts, which is right only for work that needs none.
  Discord and anything else the daemon posts through a stored key needs no persona and ignores this.
- scheduledAt: your SUGGESTED time in epoch ms, \`date -d "2026-07-10 09:00 +02:00" +%s%3N\` (always give an
  explicit UTC offset; the sandbox clock is UTC). Omit it to let the owner pick the time at approval.
- status: defaults to "proposed" if omitted, and PROPOSED IS THE ONLY ONE YOU MAY WRITE. The owner approves in
  the app, which starts a short countdown they can still stop; the daemon then either does it itself or wakes
  you naming the exact files to act on. An item you mark approved yourself skips the countdown and takes the
  decision away from them.
`;

// Approvals are native to every sandbox (like automations), so no capability owns this skill, the daemon
// converges it at boot (the composeEnvironment pattern), keeping the prose current across daemon updates.
export const ensureApprovalsSkill = (services: Pick<Services, "files" | "workspace">): Promise<void> =>
    writeLoadedSkill(services.files, services.workspace.root, "approvals", APPROVALS_SKILL);
