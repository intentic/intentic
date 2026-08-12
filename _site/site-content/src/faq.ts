import { compareHref } from "./compare";
import { docsHref } from "./docs";
import { guidesHref } from "./guides";

export interface FaqItem {
    /** Anchor id: a question is linkable on its own (`/#can-intentic-read-my-secrets`). */
    id: string;
    question: string;
    /** Each entry is a paragraph of the answer. */
    answer: string[];
    /**
     * A page carrying the long answer. Rendered under the paragraphs and absent from the
     * FAQPage schema: the answer above has to stand on its own, because a rich result shows the text and
     * not the link.
     */
    more?: { label: string; href: string };
}

/**
 * One topic band of the FAQ. The landing page renders each question as a collapsed disclosure, so a band
 * is a short list of headlines a visitor skims: the grouping tells them which three or four questions are
 * worth opening, and nothing below the fold is spent on answers nobody asked for.
 */
export interface FaqGroup {
    /** Anchor id for the topic nav; prefixed so it can never collide with a question's id. */
    id: string;
    label: string;
    /** One line under the label: what this band answers, so a reader knows whether to skim it at all. */
    blurb: string;
    items: FaqItem[];
}

// The objection bank from docs/marketing/messaging.md: answers verified against intentic-app and the engine repo.
export const faqGroups: FaqGroup[] = [
    {
        id: "faq-what-it-is",
        label: "What it is",
        blurb: "The product, how it differs, and what it runs alongside.",
        items: [
            {
                id: "close-the-browser",
                question: "What happens when I close the browser?",
                answer: [
                    "Nothing. The agents live on your machine, not in the tab, so terminals stay open and turns finish without you. Reopen from any device and the same fleet is there, sorted by who needs you.",
                ],
                more: {
                    label: "What keeps an agent running when a machine sleeps",
                    href: guidesHref("keep-a-coding-agent-running-after-you-close-your-laptop"),
                },
            },
            {
                id: "how-is-this-different",
                question: "How is this different from a custom GPT or a .md instructions file?",
                answer: [
                    "Those are a prompt on a generic assistant: nothing installed, no reach into your code, a blank context every time. An agent here gets a container with real tools, credentials for your repos, and its skills loaded every run.",
                ],
            },
            {
                id: "how-does-it-compare",
                question: "How does this compare to Conductor, Cursor, OpenCode or Nimbalyst?",
                answer: [
                    "Mostly it doesn't compete. Claude Code, Codex and OpenCode are agent harnesses, and intentic runs all of them. Against a cloud platform, the only real question is whose computer holds your source.",
                ],
                more: { label: "Every comparison, with the case for the other product", href: compareHref("") },
            },
            {
                id: "run-a-fleet",
                question: "Can I run a separate agent for each job?",
                answer: [
                    "Yes, that's the intended shape: a migrations agent, a release captain, a support triager, each with the access its job needs. Automations wake them on a schedule or an event.",
                ],
                more: { label: "Specialize a sandbox until it does a job alone", href: docsHref("autonomous-employees") },
            },
            {
                id: "sandbox-or-persona",
                question: "Should I start a new sandbox or add a new persona?",
                answer: [
                    "A sandbox has its own tools, systems, budget and code: start one for a different job. A persona is who a sandbox speaks as when it posts outside intentic: add one when the work is the same but the identity changes, like a brand account beside your own.",
                ],
                more: { label: "Specialize a sandbox, then grow a team", href: docsHref("autonomous-employees") },
            },
            {
                id: "which-models",
                question: "Which AI models does it use?",
                answer: [
                    "Claude Code (Opus, Sonnet, Haiku), Codex, Grok, Kimi Code or Google, picked per conversation. Your provider, your account, your usage.",
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
                    "A machine with Docker and a Google account. No open inbound ports, nothing deployed. Docker installs itself if missing, with your confirmation.",
                ],
            },
            {
                id: "do-i-need-cloudflare",
                question: "Do I need a Cloudflare account?",
                answer: [
                    "No. The tunnel runs under intentic's own domain by default. Bring your own zone if you prefer; the token is used once and never stored.",
                ],
            },
            {
                id: "is-any-of-it-paid",
                question: "Is any of it paid?",
                answer: [
                    "No. Every sandbox, capability and shared workspace is free, with no tiers, limits or card. All of intentic is MIT on GitHub. You pay your own model provider, directly.",
                ],
            },
            {
                id: "can-the-agent-break-things",
                question: "Can the agent break my stuff?",
                answer: [
                    "It starts in plan mode: it proposes, you approve. Every change is a diff you can discard, Dockerfile changes need explicit approval, and stricter or looser modes are one click away.",
                ],
                more: { label: "How to review what an agent wrote before it lands", href: guidesHref("review-ai-generated-code-changes") },
            },
            {
                id: "production-ready",
                question: "Is it production-ready?",
                answer: [
                    "The app is new and says so, but it isn't a demo: what you get is a real, full sandbox. Every agent starts in plan mode and every change lands as a reviewable diff, so you build trust with the wheel in your hands.",
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
                    "On your machine. The sandbox runs where you start it and your browser reaches it over a private tunnel. The platform stores your identity and the sandbox's URL, and never relays your files.",
                ],
                more: { label: "Where your code goes with any coding agent", href: guidesHref("where-your-code-goes-with-cloud-coding-agents") },
            },
            {
                id: "can-intentic-read-my-secrets",
                question: "Can intentic read my secrets?",
                answer: [
                    "No. Your credentials stay inside the sandbox and never reach the platform, which holds only the connection secrets pairing a browser with a sandbox, encrypted with AES-256-GCM. Files like .env are blocked from the relay.",
                ],
                more: {
                    label: "Giving an agent credentials without leaking them",
                    href: guidesHref("give-an-ai-agent-database-and-api-access-safely"),
                },
            },
            {
                id: "open-source",
                question: "Is it open source?",
                answer: [
                    "Yes, all of it. The sandbox, CLI, workspace and platform are MIT-licensed in one public GitHub repo, so you can read every line that touches your code before you run it.",
                ],
            },
            {
                id: "my-data",
                question: "Can I export or delete my data?",
                answer: [
                    "Settings → Export downloads everything the platform stores about you as JSON. Account deletion cascades sandboxes, sessions and grants.",
                ],
            },
        ],
    },
];
