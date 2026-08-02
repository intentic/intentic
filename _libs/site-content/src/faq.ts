import { compareHref } from "./compare";
import { docsHref } from "./docs";

export interface FaqItem {
    /** Anchor id — a question is linkable on its own (`/#can-intentic-read-my-secrets`). */
    id: string;
    question: string;
    /** Each entry is a paragraph of the answer. */
    answer: string[];
    /**
     * A page carrying the long answer. Rendered under the paragraphs and deliberately absent from the
     * FAQPage schema: the answer above has to stand on its own, because a rich result shows the text and
     * not the link.
     */
    more?: { label: string; href: string };
}

/**
 * One topic band of the FAQ. The landing page renders every answer open, so the grouping is what keeps
 * thirteen questions scannable: a visitor jumps to the band their objection lives in rather than opening
 * rows one at a time.
 */
export interface FaqGroup {
    /** Anchor id for the topic nav; prefixed so it can never collide with a question's id. */
    id: string;
    label: string;
    /** One line under the label — what this band answers, so the nav choice is informed. */
    blurb: string;
    items: FaqItem[];
}

// The objection bank from docs/marketing/messaging.md — answers verified against intentic-app and the engine repo.
export const faqGroups: FaqGroup[] = [
    {
        id: "faq-what-it-is",
        label: "What it is",
        blurb: "The product, how it differs, and what it runs alongside.",
        items: [
            {
                id: "how-is-this-different",
                question: "How is this different from a custom GPT or a .md instructions file?",
                answer: [
                    "Those are a prompt: instructions on top of a generic assistant. It can describe your stack, but nothing is installed, it can't reach your code or services, and it starts from a blank context every time.",
                    "A specialized agent here gets a sandbox of its own. Its dev-tools and libraries are really installed (an environment overlay), it's wired to your repos, databases, and services (capabilities), and its skills and house style load every run — so it does the job end to end and shows its work as diffs.",
                ],
            },
            {
                id: "how-does-it-compare",
                question: "How does this compare to Conductor, Cursor, OpenCode or Nimbalyst?",
                answer: [
                    "For most of that list it doesn't compete. Claude Code, Codex and OpenCode are agent harnesses — intentic runs all of them, and any agent speaking the Agent Client Protocol is one capability away. Cursor and the other AI editors put you at the keyboard; intentic puts the agent there, and desktop sync mirrors the sandbox into a folder your own editor opens.",
                    "The real comparison is with local orchestrators like Conductor and Nimbalyst, which share the ownership stance and differ on scope: intentic also gives the agent an image whose tools are really installed, credentials for your systems, events that wake it, and a browser that reaches it from anywhere. The one genuine either/or is a cloud agent platform, because that is a question about whose computer holds your source.",
                ],
                more: { label: "Where intentic sits — every comparison, with the case for the other product", href: compareHref("") },
            },
            {
                id: "run-a-fleet",
                question: "Can I run a separate agent for each job?",
                answer: [
                    "Yes — that's the intended shape. Give each role its own sandbox (a migrations agent, a release captain, a support triager), each with the environment, access, and context its job needs. The free plan includes one sandbox; Pro runs as many as you have roles.",
                    "The automations extension wakes them on a schedule or an event — a push, a Sentry alert, a Stripe payment, new email, a Discord message, or plain cron — each run a fresh session with its own transcript, optionally gated by a guard command you define. One agent's run can fire the webhook that wakes another, so a whole workflow moves through specialized hands.",
                ],
                more: { label: "Specialize a sandbox until it does a job alone", href: docsHref("autonomous-employees") },
            },
            {
                id: "which-models",
                question: "Which AI models does it use?",
                answer: [
                    "Your choice per conversation: Claude Code (Opus, Sonnet, Haiku), Codex, or Grok, with adjustable reasoning effort. Your provider, your account, your usage.",
                ],
            },
        ],
    },
    {
        id: "faq-getting-started",
        label: "Getting started",
        blurb: "What you need, what it costs, what it can touch.",
        items: [
            {
                id: "what-do-i-need",
                question: "What do I need to run a sandbox?",
                answer: [
                    "A machine with Docker (installed automatically if missing, with your confirmation) and a Google account. No open inbound ports, nothing deployed.",
                ],
            },
            {
                id: "do-i-need-cloudflare",
                question: "Do I need a Cloudflare account?",
                answer: [
                    "No. By default intentic provisions the tunnel under its own domain. Bring your own zone if you prefer — your token is used once to list zones and is never stored.",
                ],
            },
            {
                id: "free-vs-pro",
                question: "What's free and what's Pro?",
                answer: [
                    "Free: one full sandbox — every capability, the agent, and automations included. Pro: unlimited sandboxes and team sharing (invite by email).",
                    "Pricing at checkout via Stripe; cancel anytime. Removing access (revoke, leave) never requires Pro.",
                ],
            },
            {
                id: "can-the-agent-break-things",
                question: "Can the agent break my stuff?",
                answer: [
                    "It starts in plan mode: it proposes, you approve. Every file change is reviewable as a diff you can discard or commit; environment (Dockerfile) changes require your explicit approval.",
                    "Stricter and looser permission modes are one click away.",
                ],
            },
            {
                id: "production-ready",
                question: "Is it production-ready?",
                answer: [
                    "The app is new and says so — but it isn't a demo: the free plan is a real, full sandbox. Read exactly what it does before pointing an agent at anything you care about.",
                    "Every agent starts in plan mode and every change lands as a reviewable diff, so you build trust with the wheel in your hands.",
                ],
            },
        ],
    },
    {
        id: "faq-ownership",
        label: "Ownership & privacy",
        blurb: "Where your code, secrets and data actually sit.",
        items: [
            {
                id: "where-does-my-code-live",
                question: "Where does my code live?",
                answer: [
                    "On your machine. The sandbox runs where you start it; your browser reaches it over a private Cloudflare tunnel.",
                    "The platform stores your identity and the sandbox's URL — it never relays your files or sits between you and your sandbox.",
                ],
            },
            {
                id: "can-intentic-read-my-secrets",
                question: "Can intentic read my secrets?",
                answer: [
                    "No. Credentials live inside your sandbox; the platform has no path to them. What little the platform does store (OAuth tokens, connect tokens) is AES-256-GCM encrypted with no decrypt path in the product.",
                    "Secret files like .env are denylisted from the workspace file relay, so they never leave the sandbox.",
                ],
            },
            {
                id: "open-source",
                question: "Is it open source?",
                answer: [
                    "Yes — the sandbox and CLI that run on your machine are MIT-licensed on GitLab, so you can read exactly what touches your code and credentials before you ever run it.",
                    "The hosted platform adds accounts, billing, and the thin connection layer between your browser and your sandbox — it stays off the command path and never sees your code.",
                ],
            },
            {
                id: "my-data",
                question: "What about my data — export, deletion?",
                answer: [
                    "Settings → Export downloads everything the platform stores about your account as JSON (deliberately excluding credentials). Account deletion cancels billing and cascades sandboxes, sessions, and grants.",
                ],
            },
        ],
    },
];
