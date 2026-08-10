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

// The objection bank from docs/marketing/messaging.md — answers verified against intentic-app and the engine repo.
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
                    "Nothing, to the runs. The agents live on your machine, not in the tab — terminals survive the disconnect, and turns finish without you.",
                    "Reopen from any device, including a phone, and the same fleet is there, sorted by who now needs you.",
                ],
            },
            {
                id: "how-is-this-different",
                question: "How is this different from a custom GPT or a .md instructions file?",
                answer: [
                    "Those are a prompt on a generic assistant: nothing installed, no reach into your code, a blank context every time.",
                    "An agent here gets a container with its tools really installed, credentials for your repos and databases, and its skills loaded every run.",
                ],
            },
            {
                id: "how-does-it-compare",
                question: "How does this compare to Conductor, Cursor, OpenCode or Nimbalyst?",
                answer: [
                    "Mostly it doesn't compete. Claude Code, Codex and OpenCode are agent harnesses, and intentic runs all of them.",
                    "Local orchestrators like Conductor share the ownership stance. Against a cloud platform, the only real question is whose computer holds your source.",
                ],
                more: { label: "Every comparison, with the case for the other product", href: compareHref("") },
            },
            {
                id: "run-a-fleet",
                question: "Can I run a separate agent for each job?",
                answer: [
                    "Yes, that's the intended shape: a migrations agent, a release captain, a support triager, each with the environment and access its job needs.",
                    "Automations wake them on a schedule or an event, each run a fresh session with its own transcript.",
                ],
                more: { label: "Specialize a sandbox until it does a job alone", href: docsHref("autonomous-employees") },
            },
            {
                id: "sandbox-or-persona",
                question: "Should I start a new sandbox or add a new persona?",
                answer: [
                    "Go by what's different. A sandbox is a whole workspace of its own — its tools, the systems it's connected to, its budget and its code. Start a new one when the job is genuinely different, or when you want that work kept apart with its spend on its own tab.",
                    "A persona is who a sandbox is when it posts to the outside world: it ties together the logins that are the same someone, so the agent speaks as that account and no others. Add one — no new sandbox needed — when the work is the same but you want a different face for it, like posting as a brand account alongside your own.",
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
                    "No. The tunnel is provisioned under intentic's own domain by default. Bring your own zone if you prefer; the token is used once and never stored.",
                ],
            },
            {
                id: "is-any-of-it-paid",
                question: "Is any of it paid?",
                answer: [
                    "No. Every sandbox, every capability and team sharing are free — no tiers, no limits, no card.",
                    "All of intentic is MIT on GitHub, platform included. You pay your own model provider, directly.",
                ],
            },
            {
                id: "can-the-agent-break-things",
                question: "Can the agent break my stuff?",
                answer: [
                    "It starts in plan mode: it proposes, you approve. Every change is a diff you can discard, and Dockerfile changes need explicit approval.",
                    "Stricter and looser permission modes are one click away.",
                ],
            },
            {
                id: "production-ready",
                question: "Is it production-ready?",
                answer: [
                    "The app is new and says so, but it isn't a demo: what you get is a real, full sandbox.",
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
                    "On your machine. The sandbox runs where you start it, and your browser reaches it over a private tunnel.",
                    "The platform stores your identity and the sandbox's URL. It never relays your files.",
                ],
            },
            {
                id: "can-intentic-read-my-secrets",
                question: "Can intentic read my secrets?",
                answer: [
                    "No. Your capability credentials live inside your sandbox and the platform never receives them. The connection secrets it does hold — the ones that pair a browser to a sandbox — are encrypted at rest with AES-256-GCM.",
                    "Secret files like .env are denylisted from the file relay, so they never leave the sandbox.",
                ],
            },
            {
                id: "open-source",
                question: "Is it open source?",
                answer: [
                    "Yes, all of it. intentic is MIT on GitHub — the sandbox, the CLI, the workspace and the hosted platform, developed in one public repo — so you can read every line that touches your code before you run it.",
                    "The platform adds accounts and the connection layer. It stays off the command path, and now you can check that for yourself rather than take our word for it.",
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
