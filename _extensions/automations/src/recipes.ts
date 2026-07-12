/* "Start from" suggestions in the new-automation dialog, shown only when the matching capability provider is
 * enabled. Pure prefill — the daemon knows nothing about recipes. Discord listens live over the daemon's own
 * gateway connection (a `listener` trigger); services that can't push webhooks or be listened to (IMAP) get
 * scheduled-poll recipes that lean on the agent's CLI capability instead. Moved here from @intentic-app/catalog:
 * recipes are automation-UI data, so they live with the automations extension, not the platform catalog. */

export interface AutomationRecipe {
    // Matches a capability's config.provider — the recipe shows only when that capability is enabled. Absent ⇒
    // always shown (a recipe that needs no capability, e.g. publishing drafts through whatever skills exist).
    readonly provider?: string;
    readonly title: string;
    // Simple-icons slug, same convention as a capability card's logo.
    readonly logo?: string;
    readonly id: string; // prefills the automation name
    readonly trigger:
        | { readonly kind: "event" }
        | { readonly kind: "schedule"; readonly cron: string }
        | { readonly kind: "listener"; readonly provider: "discord" };
    // Prefills the guard command (a shell one-liner; non-zero exit skips the wake).
    readonly guard?: string;
    readonly prompt: string;
    readonly note?: string; // card disclosure, e.g. "instant" / "checks every 5 min"
    readonly setup?: string; // post-save instructions: where to paste the webhook URL
}

export const AUTOMATION_RECIPES: readonly AutomationRecipe[] = [
    {
        provider: "github",
        title: "Push to repo",
        logo: "github/f5f5f5",
        id: "github-push",
        trigger: { kind: "event" },
        prompt: "A push just landed — the webhook payload is in $AUTOMATION_PAYLOAD. Review the new commits and summarize what changed.",
        setup: "In the GitHub repo: Settings → Webhooks → Add webhook → paste this URL as the Payload URL, content type application/json.",
    },
    {
        provider: "gitlab",
        title: "Push to repo",
        logo: "gitlab",
        id: "gitlab-push",
        trigger: { kind: "event" },
        prompt: "A push just landed — the webhook payload is in $AUTOMATION_PAYLOAD. Review the new commits and summarize what changed.",
        setup: "In the GitLab project: Settings → Webhooks → paste this URL and check Push events.",
    },
    {
        provider: "sentry",
        title: "New alert",
        logo: "sentry",
        id: "sentry-alert",
        trigger: { kind: "event" },
        prompt: "A Sentry alert just fired — the payload is in $AUTOMATION_PAYLOAD. Investigate the error and suggest a fix.",
        setup: "In Sentry: Alerts → your alert rule → add a webhook action pointing at this URL.",
    },
    {
        provider: "stripe",
        title: "Payment events",
        logo: "stripe",
        id: "stripe-events",
        trigger: { kind: "event" },
        prompt: "A Stripe event just arrived — the payload is in $AUTOMATION_PAYLOAD. Summarize it and flag anything that needs attention.",
        setup: "In the Stripe Dashboard: Developers → Webhooks → Add endpoint → paste this URL and pick the events to send.",
    },
    {
        provider: "imap",
        title: "New email",
        id: "new-email",
        trigger: { kind: "schedule", cron: "*/5 * * * *" },
        prompt: "Check the inbox over IMAP for mail that arrived since the last run. Summarize anything urgent.",
        note: "checks every 5 min",
    },
    {
        // No provider — posting uses whatever platform skills the sandbox has (X/Reddit/YouTube browser, Discord
        // CLI). The guard reads the drafts the agent proposed and wakes only when one is approved and due.
        title: "Publish approved drafts",
        id: "publish-drafts",
        trigger: { kind: "schedule", cron: "*/15 * * * *" },
        guard: `jq -es --argjson now "$(date +%s%3N)" 'any(.[]; .status=="approved" and ((.scheduledAt // $now) <= $now))' .intentic/drafts/*.json`,
        prompt:
            `Publish due post drafts. Read every JSON file in .intentic/drafts/ — a draft is due when its status is "approved" and it either has no ` +
            `scheduledAt or its scheduledAt <= now (epoch ms; get now with: date +%s%3N). For each due draft, one at a time: (1) edit its file to set ` +
            `"status":"posting"; (2) post exactly its content (with its title/target/media) on its platform using that platform's skill; (3) edit the ` +
            `file to "status":"posted" plus "postedAt" (epoch ms), or "status":"failed" plus an "error" string describing what went wrong. Never rewrite ` +
            `the content; never touch drafts that are not approved and due.`,
        note: "checks every 15 min",
    },
];
