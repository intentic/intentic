import type { WorkspaceEventKind } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/extension-ui";

/* "Start from" suggestions in the new-automation dialog, shown only when the matching capability provider is
 * enabled. Pure prefill — the daemon knows nothing about recipes. Discord and IMAP listen live over their
 * gateway extensions' connections (a `listener` trigger); services that can't push webhooks or be listened to
 * get scheduled-poll recipes that lean on the agent's CLI capability instead. Moved here from
 * @intentic-app/capability-catalog: recipes are automation-UI data, so they live with the automations
 * extension, not the platform catalog.
 *
 * The `chore: true` ones are different in kind: they watch THIS workspace (a `workspace` trigger) rather than
 * the outside world, and they get a shelf of their own on the Automations page. See AutomationRecipe.chore. */

export interface AutomationRecipe {
    // Matches a capability's config.provider — the recipe shows only when that capability is enabled. Absent ⇒
    // always shown (a recipe that needs no capability, e.g. publishing drafts through whatever skills exist).
    readonly provider?: string;
    readonly title: string;
    // Simple-icons slug, same convention as a capability card's logo.
    readonly logo?: string;
    // An app Icon, for recipes with no brand behind them — every chore, since the thing they watch is your
    // own codebase. Same logo/icon split listenerSources draws.
    readonly icon?: IconName;
    readonly id: string; // prefills the automation name
    readonly trigger:
        | { readonly kind: "event" }
        | { readonly kind: "schedule"; readonly cron: string }
        | { readonly kind: "listener"; readonly provider: "discord" | "imap"; readonly eventType?: "message" }
        | { readonly kind: "workspace"; readonly event: WorkspaceEventKind };
    // Prefills the guard command (a shell one-liner; non-zero exit skips the wake).
    readonly guard?: string;
    readonly prompt: string;
    readonly note?: string; // card disclosure, e.g. "instant" / "checks every 5 min"
    readonly setup?: string; // post-save instructions: where to paste the webhook URL
    // A code CHORE: it watches this workspace rather than the outside world, so it gets its own shelf on the
    // Automations page (see AutomationsView) instead of living only inside the create dialog's "Start from"
    // gallery. Chores are the one kind of automation a user is expected to want without knowing it exists, so
    // the shelf lists them OFF and one click creates the row — never a hidden toggle, always a real automation.
    readonly chore?: true;
    // What the shelf card says under the title. Chores only — every other recipe is picked from a gallery where
    // the title plus its trigger is enough context.
    readonly description?: string;
}

// A change-triggered chore diffs the same way, and getting it wrong is the difference between reviewing the
// change and reviewing the whole repo: the payload's span is OPEN (`git diff <from>`, no upper bound) precisely
// so a turn that errored — leaving its work uncommitted in the worktree — still reads as the change it made.
const SPAN_NOTE =
    "$AUTOMATION_PAYLOAD is a JSON object describing what changed. For each entry in its `repos`, " +
    "`git -C <dir> diff <from>` is exactly that repo's change — committed and uncommitted both. Look at nothing else: " +
    "the rest of the workspace is not what this run is about.";

// Where each tool-driven chore's guard leaves its report for the prompt to read. A guard's stdout is discarded
// on success (only a FAILING guard's output survives, as the skip reason), so a file is how the free
// deterministic half hands its findings to the half that costs a turn.
const KNIP_OUT = "/tmp/intentic-knip.json";
const JSCPD_DIR = "/tmp/intentic-jscpd";
const AUDIT_OUT = "/tmp/intentic-audit.json";

// Every tool-driven chore says this, because the failure mode is the same for all of them: a tool that reports
// N findings is not reporting N problems, and a chore that mechanically actions the whole list is worse than no
// chore at all — it makes noisy, confident, wrong changes at 3am.
const TRIAGE_NOTE =
    "The tool woke you; it did not decide anything. Read the repo before you touch it, and treat every finding as a " +
    "claim to verify rather than a task to execute. Whatever you change lands in the workspace as uncommitted work " +
    "for the owner to review, so keep it small, mechanical and separately explainable.";

export const AUTOMATION_RECIPES: readonly AutomationRecipe[] = [
    {
        chore: true,
        title: "Review agent work",
        icon: "eye",
        id: "review-agent-work",
        trigger: { kind: "workspace", event: "turn.settled" },
        description: "After every isolated agent turn, read its diff and report what it got wrong — before you decide to land it.",
        // Sub-20-line changes are not worth a turn's spend; the sum is over added + deleted across every repo in
        // the span. Binary files contribute "-" columns, which awk reads as 0 — a binary-only change skips, which
        // is the right answer anyway.
        guard:
            `printf '%s' "$AUTOMATION_PAYLOAD" | jq -r '.repos[] | "\\(.dir) \\(.from)"' | ` +
            `while read -r dir from; do git -C "$dir" diff --numstat "$from"; done | awk '{ n += $1 + $2 } END { exit !(n >= 20) }'`,
        prompt:
            `An agent just finished a turn. ${SPAN_NOTE}\n\n` +
            `Review that diff. Report findings that would change what someone does next: correctness bugs, unhandled edge cases, ` +
            `behaviour that contradicts this repo's own conventions, and tests that should exist for this change but don't. ` +
            `Cite file:line for each one and keep it to what you can point at. If the change is fine, say so in one line — ` +
            `do not manufacture findings to look useful.`,
        note: "skips changes under 20 lines",
    },
    {
        chore: true,
        title: "Clear out dead code",
        icon: "trash",
        id: "dead-code-sweep",
        trigger: { kind: "schedule", cron: "0 3 * * *" },
        description: "Runs knip nightly and only wakes when it finds something — unused files, exports and dependencies, removed for you.",
        // Two gates, so the two ways to not run are distinguishable in the run history: knip absent (a repo that
        // never adopted it) reads differently from knip clean. `pnpm exec` resolves the repo's own devDependency
        // rather than downloading a floating version that would disagree with its knip.json.
        guard:
            `pnpm exec knip --version >/dev/null 2>&1 || { echo "knip is not a devDependency of this repo"; exit 1; }; ` +
            `pnpm exec knip --reporter json > ${KNIP_OUT} && { echo "no dead code"; exit 1; }`,
        prompt:
            `knip's findings for this workspace are in ${KNIP_OUT} (JSON). ${TRIAGE_NOTE}\n\n` +
            `knip is confidently wrong about anything reachable from outside the repo: a package's public entry points, ` +
            `files a bundler or framework loads by convention, types consumed only by a downstream package. Check each ` +
            `finding against how the file is actually used before touching it.\n\n` +
            `Delete what is genuinely unreachable — dead files, unused exports, dependencies nothing imports — and run the ` +
            `repo's typecheck afterwards to prove nothing broke. Leave the false positives alone and list them in one line ` +
            `each, so the next run's reader knows they were considered rather than missed.`,
        note: "nightly · wakes only on findings",
    },
    {
        chore: true,
        title: "Find duplication",
        icon: "clone",
        id: "duplication-sweep",
        trigger: { kind: "schedule", cron: "0 3 * * 1" },
        description: "Runs jscpd weekly and reports copy-paste worth collapsing. Reports only — deduplicating is a judgement call.",
        // Gated on a percentage rather than "any clone at all", which every real repo has: below this the report
        // is noise that would wake the agent every week to say nothing actionable.
        guard:
            `pnpm dlx jscpd --reporters json --output ${JSCPD_DIR} --min-lines 12 --threshold 100 . >/dev/null 2>&1; ` +
            `[ "$(jq '.statistics.total.percentage // 0 | floor' ${JSCPD_DIR}/jscpd-report.json 2>/dev/null || echo 0)" -ge 5 ]`,
        prompt:
            `jscpd's clone report for this workspace is in ${JSCPD_DIR}/jscpd-report.json. ${TRIAGE_NOTE}\n\n` +
            `Most duplication is not worth removing: generated files, tests that are repetitive on purpose, and two ` +
            `things that merely look alike today but answer to different owners. Report the clones where the copies ` +
            `genuinely have to change together — cite both file:line ranges, say what the shared concept is, and name ` +
            `where the extraction would live. Do NOT edit anything: collapsing duplication is a design decision, not a chore.`,
        note: "weekly · wakes above 5% duplication",
    },
    {
        chore: true,
        title: "Check dependencies",
        icon: "shield",
        id: "security-sweep",
        trigger: { kind: "schedule", cron: "0 4 * * *" },
        description: "Runs pnpm audit nightly and wakes only on high or critical advisories — patching the ones that are a version bump.",
        guard:
            `pnpm audit --json > ${AUDIT_OUT} 2>/dev/null; ` +
            `[ "$(jq '(.metadata.vulnerabilities.high // 0) + (.metadata.vulnerabilities.critical // 0)' ${AUDIT_OUT} 2>/dev/null || echo 0)" -gt 0 ]`,
        prompt:
            `pnpm audit's report is in ${AUDIT_OUT} (JSON), and it woke you because it carries a high or critical advisory. ${TRIAGE_NOTE}\n\n` +
            `For each one, establish whether this workspace actually reaches the vulnerable code path — a transitive dependency ` +
            `of a build-time-only tool is a different problem from one in a running service. Where the fix is a version bump the ` +
            `lockfile can absorb, make it and run the repo's typecheck and tests to prove nothing broke. Where it needs a real ` +
            `upgrade or has no patch yet, leave it and say what it would take. Never rewrite application code to route around a CVE.`,
        note: "nightly · high + critical only",
    },
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
        trigger: { kind: "listener", provider: "imap", eventType: "message" },
        prompt:
            "New email just arrived — each payload line is one JSON event with the sender, subject and a text excerpt. Summarize anything urgent; " +
            "fetch the full message over IMAP (curl imaps://, by extra.uid) when you need more than the excerpt.",
        note: "instant",
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
