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
                    "A custom GPT or instructions file changes what an assistant is told. It does not install tools or connect to your code. In intentic, an agent works inside a container with the tools, repository access and instructions it needs for the job.",
                ],
            },
            {
                id: "how-does-it-compare",
                question: "How does this compare to Conductor, Cursor, OpenCode or Nimbalyst?",
                answer: [
                    "Claude Code, Codex and OpenCode can run inside intentic. Cursor can work beside it. Local orchestrators such as Conductor and Nimbalyst are the closest comparisons because they also manage several agents. Cloud platforms differ most in where your source code runs.",
                ],
                more: { label: "Every comparison, with the case for the other product", href: compareHref("") },
            },
            {
                id: "run-a-fleet",
                question: "Can I run a separate agent for each job?",
                answer: [
                    "Yes, that's the intended shape: a migrations agent, a storefront maintainer, a support agent, each with the access its job needs. Automations wake them on a schedule or an event.",
                ],
                more: { label: "Specialize a sandbox until it does a job alone", href: docsHref("autonomous-employees") },
            },
            {
                id: "sandbox-or-persona",
                question: "Should I start a new sandbox or add a new persona?",
                answer: [
                    "Create a sandbox when a job needs different code, tools, connected systems or its own budget. Add a persona when the job stays the same but the agent needs to speak as a different public identity, such as a brand account instead of your personal account.",
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
                    "A computer with Docker and a Google account. You do not need a public IP address or any open inbound ports. If Docker is missing, the installer offers to install it after you confirm.",
                ],
            },
            {
                id: "do-i-need-cloudflare",
                question: "Do I need a Cloudflare account?",
                answer: [
                    "No. intentic provides the private connection by default. You can use your own Cloudflare domain instead; the setup token is used once to find the domain and is not stored.",
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
                    "An agent can make mistakes, so it starts by proposing a plan for you to approve. You can review or discard every file change, and changes to installed software need separate approval. You can change the agent's permissions at any time.",
                ],
                more: { label: "How to review what an agent wrote before you accept it", href: guidesHref("review-ai-generated-code-changes") },
            },
            {
                id: "production-ready",
                question: "Is it production-ready?",
                answer: [
                    "It is a working product, but it is new. Start with low-risk work and review the results. Every agent proposes a plan first, and every file change is shown as a diff before you accept it.",
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
                    "On your machine. The sandbox runs where you start it, and your browser connects over a private tunnel. The platform stores your identity and the sandbox's URL. It never receives your files.",
                ],
                more: { label: "Where your code goes with any coding agent", href: guidesHref("where-your-code-goes-with-cloud-coding-agents") },
            },
            {
                id: "can-intentic-read-my-secrets",
                question: "Can intentic read my secrets?",
                answer: [
                    "No. Your credentials stay inside the sandbox and never reach the platform. The platform stores only encrypted tokens that connect your browser to the sandbox. Secret files such as .env are never sent through that connection.",
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
                    "Settings → Export downloads everything the platform stores about you as JSON. Deleting your account also deletes its sandbox records, sessions and access permissions.",
                ],
            },
        ],
    },
];
