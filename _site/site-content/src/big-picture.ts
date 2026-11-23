// The words of /docs/big-picture/: one person, signed in once, reaching a sandbox for each part of their life, and what
// each of those reaches. `BigPictureFigure.astro` draws it and the page explains it; this file is the only place either
// is worded, so the drawing's captions and the prose under it cannot drift apart.
//
// THE ONE PLACE THIS PICTURE IS EASY TO GET WRONG is the middle band. intentic.dev holds the account and the address book,
// and its relay carries the traffic between a screen and a sandbox. The account service is beside that path, never on
// it; the relay is on it and keeps nothing. docs/architecture/topology.md ("Trust model") is the source: change the
// band's words only with that table in hand.

/** A screen a person signs in from. */
export interface BigPictureKiosk {
    id: "browser" | "desktop" | "phone" | "os";
    name: string;
    line: string;
    /** The laptop that also runs the home sandbox and serves as one of its tools. */
    laptop?: true;
}

/** One thing a sandbox's agents can reach, drawn below the sandbox. The id also picks its glyph. */
export interface BigPictureReach {
    id: "laptop" | "phone" | "assistant" | "server" | "github" | "elevenlabs" | "drive";
    name: string;
    line: string;
    laptop?: true;
}

/** A conversation running in a sandbox: the agent's task, and where it stands. */
export interface BigPictureAgent {
    task: string;
    state: "working" | "waiting" | "ready";
    stateLabel: string;
}

export interface BigPictureSandbox {
    /** The figure's lighting key. */
    id: "home" | "game" | "work";
    /** The sandbox's own name, as the app writes it. */
    name: string;
    /** Which part of life it is for, and whose it is. */
    purpose: string;
    owner: string;
    /** The machine it runs on. */
    host: { name: string; kind: "own" | "hosted"; laptop?: true };
    agents: readonly BigPictureAgent[];
    /** What lives inside it: folders, and the keys it holds for what it reaches. */
    files: readonly string[];
    keys: readonly string[];
    reaches: readonly BigPictureReach[];
    /** Shown while the pointer is on this sandbox or anything it reaches. */
    caption: { title: string; body: string };
}

/** One step of the tour, and one tab over the figure. */
export interface BigPictureStep {
    id: "signin" | "relay" | "sandboxes" | "reach" | "agents" | "laptop" | "sharing";
    tab: string;
    title: string;
    body: string;
}

export interface BigPictureScene {
    heading: string;
    sub: string;
    kiosks: readonly BigPictureKiosk[];
    colleague: { name: string; line: string; kiosk: string };
    /** `relayTag` is cut into the strip the wires pass through; `relay` says what that strip does. */
    platform: { name: string; knows: string; relay: string; relayTag: string };
    sandboxes: readonly BigPictureSandbox[];
    link: { label: string; line: string };
    steps: readonly BigPictureStep[];
    /** Spoken equivalent of the whole drawing, for a reader who never sees it. */
    label: string;
}

export const bigPictureScene: BigPictureScene = {
    heading: "One account, a sandbox for each part of your life",
    sub: "Sign in from any screen. Each sandbox keeps its own agents, files and keys, runs where you chose, and reaches only what you connected to it.",
    kiosks: [
        { id: "browser", name: "Browser", line: "any computer" },
        { id: "desktop", name: "Desktop app", line: "on your laptop", laptop: true },
        { id: "phone", name: "Phone", line: "the same board" },
        { id: "os", name: "Intentic OS", line: "boots into it" },
    ],
    colleague: { name: "Ola", line: "a colleague", kiosk: "her own laptop" },
    platform: {
        name: "intentic.dev",
        knows: "Holds each account, and the address of every sandbox it is in.",
        relay: "Its relay carries each screen's traffic down the tunnel the sandbox opened, and stores none of it.",
        relayTag: "relay",
    },
    sandboxes: [
        {
            id: "home",
            name: "home",
            purpose: "Home",
            owner: "yours",
            host: { name: "your laptop", kind: "own", laptop: true },
            agents: [
                { task: "Sort the family photos", state: "working", stateLabel: "Working" },
                { task: "Renew the car insurance", state: "waiting", stateLabel: "Waiting for you" },
            ],
            files: ["photos/", "paperwork/"],
            keys: ["Gmail"],
            reaches: [
                { id: "laptop", name: "Your laptop", line: "as a tool", laptop: true },
                { id: "phone", name: "Your phone", line: "Android app" },
                { id: "assistant", name: "Home Assistant", line: "MCP server" },
            ],
            caption: {
                title: "home runs on your laptop",
                body: "Its agents may use your laptop, your phone and your Home Assistant, within the switches you set on each. Nothing in it can reach the game's server or Acme's Drive: those keys live in other sandboxes.",
            },
        },
        {
            id: "game",
            name: "indie-game",
            purpose: "Hobby",
            owner: "yours",
            host: { name: "a machine we host", kind: "hosted" },
            agents: [
                { task: "Fix the jump physics", state: "ready", stateLabel: "Ready to land" },
                { task: "Voice lines for level 3", state: "working", stateLabel: "Working" },
            ],
            files: ["game/ · git"],
            keys: ["SSH key", "API key"],
            reaches: [
                { id: "server", name: "Game server", line: "SSH" },
                { id: "github", name: "GitHub", line: "your account" },
                { id: "elevenlabs", name: "ElevenLabs", line: "API key" },
            ],
            caption: {
                title: "indie-game runs on a machine we host",
                body: "It keeps working with your laptop shut. Its agents can deploy to the game server and call ElevenLabs, and they push to GitHub as you: a sign-in this sandbox holds and no other does.",
            },
        },
        {
            id: "work",
            name: "acme-portal",
            purpose: "Work",
            owner: "Ola's · you write",
            host: { name: "the office server", kind: "own" },
            agents: [
                { task: "Q3 report export", state: "working", stateLabel: "Working" },
                { task: "Ola: onboarding page", state: "waiting", stateLabel: "Waiting for Ola" },
            ],
            files: ["portal/ · git"],
            keys: ["Google", "GitHub"],
            reaches: [
                { id: "drive", name: "Google Drive", line: "Acme's account" },
                { id: "github", name: "GitHub", line: "Acme's organisation" },
            ],
            caption: {
                title: "acme-portal is Ola's, and you write in it",
                body: "It runs on the office server and reaches Acme's Drive and Acme's GitHub. Its GitHub is not yours: it is a second sign-in, held by this sandbox, that your other sandboxes never see.",
            },
        },
    ],
    link: { label: "link", line: "hands over a task, never a key" },
    steps: [
        {
            id: "signin",
            tab: "Sign in",
            title: "Sign in anywhere, as one account",
            body: "A browser on any computer, the desktop app, your phone, or a machine that boots Intentic OS. Each is only a screen: close it and nothing stops, and the next one you open shows the same sandboxes where you left them.",
        },
        {
            id: "relay",
            tab: "intentic.dev",
            title: "intentic.dev knows the way, not the work",
            body: "It holds your account and the address of every sandbox you are in. When you open one, your screen reaches it through intentic's relay, down a tunnel the sandbox opened from its own side, so the machine it runs on needs no open port. The relay routes each request and keeps none of it; your code, prompts and keys stay in the sandbox.",
        },
        {
            id: "sandboxes",
            tab: "Sandboxes",
            title: "One sandbox for each part of your life",
            body: "Home, a hobby, a job: each is a sandbox of its own, with its own files, keys, agents and history. Each runs where you chose, on your laptop, a machine we host or a server at the office. Nothing crosses between them unless you link two of yours, and a link hands over a task, never a key.",
        },
        {
            id: "reach",
            tab: "Reach",
            title: "Each sandbox reaches its own world",
            body: "A sandbox's agents use only what that sandbox was connected to: a computer, a phone, a server, a service. Connecting your GitHub to the game gives home nothing. Two sandboxes that both use GitHub hold two separate sign-ins.",
        },
        {
            id: "agents",
            tab: "Agents",
            title: "Agents do the work inside",
            body: "Every conversation is an agent working on a branch of its own. It carries on while every screen is closed, stops when it needs you, and its changes wait until you have read them and landed them. A role decides which of the sandbox's connections a conversation may use.",
        },
        {
            id: "laptop",
            tab: "One laptop",
            title: "One laptop, three jobs",
            body: "The same computer can be a screen you sign in from, the machine a sandbox runs on, and a tool that sandbox's agents use. Each is granted on its own: signing in on it hands over nothing, and as a tool it obeys the switches you set on the laptop itself.",
        },
        {
            id: "sharing",
            tab: "Sharing",
            title: "Share a sandbox, not your account",
            body: "Ola owns acme-portal and invited you to write in it. Each of you signs in as yourself, and the sandbox checks on every request who may do what. Her other sandboxes stay out of your sight, and yours out of hers.",
        },
    ],
    label: "You sign in once, from a browser, the desktop app on your laptop, your phone or Intentic OS. intentic.dev holds your account and where each sandbox is; its relay carries your screen's traffic to each sandbox and keeps none of it. You are in three sandboxes: home, which runs on your laptop and reaches your laptop, your phone and Home Assistant; indie-game, on a machine intentic hosts, which reaches a game server, GitHub and ElevenLabs; and acme-portal, owned by your colleague Ola, on the office server, which reaches Acme's Google Drive and GitHub. home and indie-game are linked. Ola signs in with her own account and reaches only acme-portal. Agents work inside each sandbox on conversations of their own.",
};
