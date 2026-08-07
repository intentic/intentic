/* THE DRAFTS PUBLISHER — one definition for the three surfaces that must agree on it.
 *
 * The daemon seeds this automation into a workspace (default-automations.ts in the sandbox package), the
 * automations extension offers it as a recipe for anyone who deleted it and wants it back, and the drafts
 * routes fire it BY THIS ID the moment an owner's edit makes a draft approved-and-due — the approve click, or
 * a reschedule pulling an approved draft's date into the past. Written once here for the chore book's own
 * reason: two copies of a prompt drift, and only one of them gets fixed when we learn how to phrase it.
 *
 * THE CRON IS NOT HOW APPROVAL GETS PUBLISHED — the instant fire is. The sweep exists for the two moments a
 * click cannot cover: a draft approved for a FUTURE scheduledAt whose time has since arrived, and an approval
 * whose instant fire was dropped because the publisher was already mid-turn (fireAutomation drops overlapping
 * fires; this sweep is what makes that drop safe to keep).
 *
 * THE GUARD IS THE PRICE GATE. A wake is a whole agent turn, and most sweep fires find nothing to do — the
 * guard answers "is anything actually approved and due" for the cost of a shell spawn, so the turn is only
 * paid for when there is a post to send. Approval-fired wakes run the same guard: the fire carries the
 * clearance of the owner's click (`cleared: "approval"`), not an exemption from the facts on disk. */
export const PUBLISH_DRAFTS_AUTOMATION = {
    id: "publish-drafts",
    title: "Publish approved drafts",
    cron: "*/5 * * * *",
    guard: `jq -es --argjson now "$(date +%s%3N)" 'any(.[]; .status=="approved" and ((.scheduledAt // $now) <= $now))' .intentic/drafts/*.json`,
    prompt:
        `Publish due post drafts. Read every JSON file in .intentic/drafts/ — a draft is due when its status is "approved" and it either has no ` +
        `scheduledAt or its scheduledAt <= now (epoch ms; get now with: date +%s%3N). For each due draft, one at a time: (1) edit its file to set ` +
        `"status":"posting"; (2) post exactly its content (with its title/target/media) on its platform using that platform's skill; (3) edit the ` +
        `file to "status":"posted" plus "postedAt" (epoch ms), or "status":"failed" plus an "error" string describing what went wrong. Never rewrite ` +
        `the content; never touch drafts that are not approved and due.`,
} as const;
