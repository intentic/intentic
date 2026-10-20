import { compareHref } from "./compare";
import { docsHref } from "./docs";
import { type GuidePage, guidesHref } from "./guides-model";
import { productHref } from "./product";

/** Phone control, checked against each vendor's own docs on this date: the field moved twice in the month before it. */
const PUBLISHED_PHONE = "2026-10-19";

// One guide per module once guides.ts outgrew its size budget; guides.ts lists it in `guidePages` in shelf order.
export const phoneGuide: GuidePage = {
    slug: "control-coding-agents-from-your-phone",
    question: "How do you control Claude Code or Codex from your phone?",
    navLabel: "Agents from your phone",
    blurb: "The phone is the remote, not the computer. Keep the agent on a machine that stays on, then choose how the phone reaches it.",
    answer: "Keep the agent on a machine that stays on and use the phone as the remote. For Claude Code, Anthropic's Remote Control connects the Claude app to a session on your computer. For Codex, the ChatGPT app reaches the ChatGPT desktop app. SSH and tmux over Tailscale work with any CLI. Open-source apps such as Happy, or a self-hosted workspace, add notifications and a phone interface.",
    facts: [
        "The agent never runs on the phone. It runs on a desktop, home server or VPS, or in a vendor's cloud VM, and every option here except the cloud stops when that machine sleeps or its process exits.",
        "Both vendors ship an official remote for a session on your own computer. Anthropic's Remote Control works on Pro, Max, Team and Enterprise plans and not with API keys. OpenAI's needs the ChatGPT desktop app on macOS or Windows as the host; its docs say it cannot be set up from the Codex CLI or IDE extension.",
        "What makes phone control usable is a push notification when an agent stops for a permission or a question. Remote Control, Happy and intentic send one; plain SSH does not.",
        "Nothing here needs an open port. Tailscale puts the phone on a private network with the machine, and Remote Control, the Codex relay, Happy and intentic all dial outward.",
        "Omnara, often suggested for this, has pivoted. As of October 2026 its site describes an open-source managed agent platform (Apache-2.0) with Claude Code and Codex only as clients, and lists no phone app.",
    ],
    options: [
        {
            name: "SSH and tmux from a phone terminal",
            what: "Termius (iOS and Android, free Starter plan) or Blink Shell (iOS, with mosh) reaching tmux on the agent's machine over Tailscale.",
            goodFor:
                "Any agent CLI, with nothing new installed on the machine. Termius has a free plan, and Blink's mosh keeps the session alive when the phone switches networks.",
            breaksWhen:
                "You want to be told when an agent stops, or to read a diff comfortably: it is a terminal on a phone keyboard, with no notifications. Tailscale's free Personal plan is for non-commercial use only.",
        },
        {
            name: "Claude Code Remote Control",
            what: "Run claude remote-control, or /remote-control inside a session, then continue from the Claude app or claude.ai/code.",
            goodFor:
                "Claude users who want Anthropic's own app on a session that runs locally. Permission prompts and questions wait for your answer from the phone, with push notifications, over outbound HTTPS only.",
            breaksWhen:
                "You use another agent or an API key, or the claude process stops: the computer has to stay on, and server mode exits after about ten minutes without a network. The transcript is stored on Anthropic's servers while connected.",
        },
        {
            name: "Codex remote connections",
            what: "The ChatGPT app on iOS or Android starts, guides, approves and reviews Codex tasks on a computer running the ChatGPT desktop app.",
            goodFor:
                "ChatGPT plan users who already use Codex in the ChatGPT desktop app on macOS or Windows. It is official and goes through OpenAI's relay.",
            breaksWhen:
                "Your agent runs in the Codex CLI or on a Linux server: OpenAI's docs say it cannot be set up from the CLI, and the host is the desktop app. Remote access stops when the computer sleeps, goes offline or closes the app.",
        },
        {
            name: "The vendor's cloud, from its app",
            what: "Claude Code on the web from the Code tab of the Claude app, or Codex cloud from the ChatGPT app. Each task runs in a VM on the vendor's side.",
            goodFor:
                "Starting work from a phone with nothing of yours left running. No extra charge on plans that include it: Claude Pro and up, ChatGPT Plus and up.",
            breaksWhen:
                "Code or credentials must stay on your machines, or the environment needs more than a setup script installs. Both start from a GitHub repository, though claude --cloud can upload a local one, and each app runs only its own vendor's agent.",
        },
        {
            name: "Happy",
            what: "Open-source (MIT) app for iOS, Android and the web. Start the agent with happy claude or happy codex, and the session syncs to the phone end-to-end encrypted, through a relay you can self-host.",
            goodFor:
                "A free phone app for Claude Code and Codex sessions on your own machine: answer permission requests and questions, get notified, start new sessions.",
            breaksWhen:
                "The machine sleeps or the happy process stops, since the session lives there. Voice approval is the one paid part, after 20 free minutes every 30 days.",
        },
        {
            name: "A self-hosted workspace",
            what: "intentic: agents run in a Docker sandbox on your laptop, desktop or VPS, each in its own git worktree, and the phone's browser opens the same board at app.intentic.dev.",
            goodFor:
                "Several agents and providers on one board. From the phone, start one, answer its question or approve its plan, read its diff inline and land it, with a notification when one stops for you.",
            breaksWhen:
                "You want a store app: it runs in the browser, and an iPhone has to add it to the Home Screen before it can notify. Phone traffic passes intentic's relay, decrypted in memory to route it and never stored. The machine has to stay on, and the product is new.",
        },
    ],
    verdict: [
        "If you use Claude Code on one computer, start with Remote Control. It is Anthropic's own app, it holds permission prompts until you answer, and it costs nothing extra on a Claude plan. If you use Codex in the ChatGPT desktop app, its remote connections do the same for Codex.",
        "If you live in a terminal or switch between agents, SSH and tmux over Tailscale from Termius or Blink works with any CLI and costs nothing. Happy adds a phone app with notifications for Claude Code and Codex sessions on your own machine.",
        "If you run several agents at once and want one board for them on any device, with each in its own worktree and its diff read before it lands, that is what intentic is: an MIT-licensed workspace whose sandbox runs on your machine. If you would rather keep nothing running, the cloud agents in the Claude and ChatGPT apps are the honest answer.",
    ],
    sections: [
        {
            heading: "What the phone actually has to do",
            body: [
                "Very little, most of the time. An agent that is working needs nobody. Phone control earns its place in the minutes an agent is stopped and waiting on you, so judge each option by how fast it gets you through those.",
            ],
            points: [
                "Tell you that an agent stopped: a permission, a question, a plan to approve.",
                "Let you answer in one tap, without typing a command on a phone keyboard.",
                "Show what changed before you say yes. A diff on a small screen is the hard part.",
                "Start or redirect a task when the idea arrives away from the desk.",
            ],
        },
        {
            heading: "The machine has to stay awake and reachable",
            body: [
                "Every local option shares one failure: the computer is the agent. A laptop asleep in a bag ends the session, whatever is on the phone. Use a desktop, a home server or a VPS, or keep a plugged-in laptop from sleeping.",
                "Reach it without forwarding a port. A private network such as Tailscale works for SSH, and the tools with their own app dial outward from the machine, so nothing on it is exposed to the internet.",
            ],
        },
        {
            heading: "An approval from a phone is still an approval",
            body: [
                "Allow on a lock screen is as binding as Allow at a desk, and it is easier to press without reading. Keep the permission rules strict for work you will steer from a phone, and leave merging to the moment you can read the diff, or to a tool that shows it inline.",
            ],
        },
    ],
    faq: [
        {
            id: "claude-code-on-phone",
            question: "Can I use Claude Code on my phone?",
            answer: "Yes, two ways. The Code tab of the Claude app on iOS and Android starts cloud sessions that run on Anthropic's infrastructure. Remote Control connects the same app to a Claude Code session on your own computer, which has to stay on with the claude process running.",
        },
        {
            id: "codex-from-phone",
            question: "Can I control Codex from my phone?",
            answer: "Yes. The ChatGPT app starts Codex cloud tasks, and its remote connections reach Codex on a computer running the ChatGPT desktop app on macOS or Windows. For the Codex CLI on a server, use SSH from a phone terminal, Happy, or a self-hosted workspace such as intentic.",
        },
        {
            id: "computer-on",
            question: "Does my computer have to stay on?",
            answer: "Yes, for every option except the vendors' cloud agents, because the agent runs on that computer. Put it on a desktop or server that stays awake, or keep a plugged-in laptop from sleeping. A laptop that suspends stops the session whatever the phone shows.",
        },
        {
            id: "ssh-from-phone-enough",
            question: "Is SSH from a phone enough?",
            answer: "For one agent and an occasional check, yes. It works with any CLI and costs nothing. It falls short when several agents run at once, since nothing tells you which one stopped, and when you need to read a long diff on a small screen.",
        },
        {
            id: "omnara-phone",
            question: "Is Omnara still a way to control Claude Code from a phone?",
            answer: "Not as of October 2026. Omnara now describes itself as an open-source managed agent platform, lists no phone app, and treats Claude Code and Codex as clients of it. For a phone remote, look at Remote Control, Happy or SSH.",
        },
    ],
    related: [
        { label: "Agents that persist", href: guidesHref("keep-a-coding-agent-running-after-you-close-your-laptop") },
        { label: "Self-hosted web agents", href: guidesHref("self-hosted-alternative-to-claude-code-on-the-web") },
        { label: "Run a fleet", href: productHref("run") },
        { label: "Quickstart", href: docsHref("quickstart") },
        { label: "intentic vs Claude Code", href: compareHref("claude-code") },
        { label: "intentic vs Codex", href: compareHref("codex") },
    ],
    meta: {
        title: "Control Claude Code and Codex from your phone",
        description:
            "Remote Control, Codex remote connections, SSH and tmux over Tailscale, Happy and self-hosted workspaces: what each lets you do from a phone, and where it stops.",
        datePublished: PUBLISHED_PHONE,
    },
};
