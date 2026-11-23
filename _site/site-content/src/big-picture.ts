// The words of /docs/big-picture/: one person, signed in once, reaching a sandbox for each part of their life, and what
// each of those reaches. `BigPictureFigure.astro` draws it and the page explains it; this file is the only place either
// is worded, so the drawing and the prose under it cannot drift apart.
//
// The drawing says everything at a glance; a reader who wants more selects a part and a peek opens under it. So each
// part has two registers here: the few words shown in the drawing, and the peek's sentence and facts.
//
// THE ONE PLACE THIS PICTURE IS EASY TO GET WRONG is intentic.dev. It holds the account and the address book, and its
// relay carries the traffic between a screen and a sandbox. The account service is beside that path, never on it; the
// relay is on it and keeps nothing. docs/architecture/topology.md ("Trust model") is the source: change those words
// only with that table in hand.

/** A screen a person signs in from. */
export interface BigPictureKiosk {
    id: "browser" | "desktop" | "phone" | "os";
    name: string;
    line: string;
    /** The laptop that also runs the home sandbox and serves as one of its tools. */
    laptop?: true;
}

/** One thing a sandbox's agents can reach. The id also picks its glyph. */
export interface BigPictureReach {
    id: "laptop" | "phone" | "assistant" | "server" | "github" | "elevenlabs" | "drive";
    name: string;
    /** How it is reached, shown only in the peek. */
    line: string;
    laptop?: true;
}

/** A conversation running in a sandbox: the agent's task, and where it stands. */
export interface BigPictureAgent {
    task: string;
    state: "working" | "waiting" | "ready";
    stateLabel: string;
}

/** What a peek says: a sentence, then labelled facts where a list reads better than prose. */
export interface BigPicturePeek {
    title: string;
    body: string;
    facts?: readonly { label: string; value: string }[];
}

export interface BigPictureSandbox {
    /** The figure's key, and the world's colour. */
    id: "home" | "game" | "work";
    /** Its name in the drawing, in words a reader recognises at once. */
    title: string;
    /** Whose it is, in a few words. */
    owner: string;
    /** Under the agent count at a glance: the one agent that wants someone, in a few words. */
    glance: string;
    host: { name: string; kind: "own" | "hosted"; laptop?: true };
    agents: readonly BigPictureAgent[];
    /** What lives inside it, shown in the peek: folders, and the sign-ins it holds for what it reaches. */
    files: readonly string[];
    keys: readonly string[];
    reaches: readonly BigPictureReach[];
    peek: { title: string; body: string };
}

export interface BigPictureScene {
    you: { name: string; screens: string };
    kiosks: readonly BigPictureKiosk[];
    colleague: { name: string; line: string };
    /** The tagline is two short sentences, drawn one under the other. */
    platform: { name: string; tagline: readonly [string, string] };
    sandboxes: readonly BigPictureSandbox[];
    peeks: Record<"you" | "platform" | "laptop" | "ola" | "link", BigPicturePeek>;
    /** Under the drawing while nothing is open. */
    hint: string;
    /** Spoken equivalent of the whole drawing, for a reader who never sees it. */
    label: string;
}

export const bigPictureScene: BigPictureScene = {
    you: { name: "You", screens: "any screen" },
    kiosks: [
        { id: "browser", name: "Browser", line: "on any computer" },
        { id: "desktop", name: "Desktop app", line: "on your laptop", laptop: true },
        { id: "phone", name: "Phone", line: "the same board" },
        { id: "os", name: "Intentic OS", line: "a machine that boots into it" },
    ],
    colleague: { name: "Ola", line: "colleague" },
    platform: { name: "intentic.dev", tagline: ["Knows the way.", "Keeps none of your work."] },
    sandboxes: [
        {
            id: "home",
            title: "Home",
            owner: "Yours",
            glance: "1 needs you",
            host: { name: "your laptop", kind: "own", laptop: true },
            agents: [
                { task: "Sort the family photos", state: "working", stateLabel: "Working" },
                { task: "Renew the car insurance", state: "waiting", stateLabel: "Waiting for you" },
            ],
            files: ["photos/", "paperwork/"],
            keys: ["Gmail sign-in"],
            reaches: [
                { id: "laptop", name: "Your laptop", line: "as a tool, within the switches you set", laptop: true },
                { id: "phone", name: "Your phone", line: "through the Android app" },
                { id: "assistant", name: "Home Assistant", line: "as an MCP server" },
            ],
            peek: {
                title: "Home runs on your laptop",
                body: "Its agents may use your laptop, your phone and your Home Assistant, within the switches you set on each. Nothing in it can reach the game's server or Acme's Drive: those sign-ins live in other sandboxes.",
            },
        },
        {
            id: "game",
            title: "Indie game",
            owner: "Your hobby",
            glance: "1 ready to land",
            host: { name: "intentic's cloud", kind: "hosted" },
            agents: [
                { task: "Fix the jump physics", state: "ready", stateLabel: "Ready to land" },
                { task: "Voice lines for level 3", state: "working", stateLabel: "Working" },
            ],
            files: ["game/, a git repository"],
            keys: ["Server SSH key", "ElevenLabs API key", "GitHub sign-in"],
            reaches: [
                { id: "server", name: "Game server", line: "over SSH" },
                { id: "github", name: "GitHub", line: "your own account" },
                { id: "elevenlabs", name: "ElevenLabs", line: "with an API key" },
            ],
            peek: {
                title: "The game runs in intentic's cloud",
                body: "It keeps working with your laptop shut. Its agents deploy to the game server, call ElevenLabs, and push to GitHub as you: a sign-in this sandbox holds and no other does.",
            },
        },
        {
            id: "work",
            title: "Acme portal",
            owner: "Work, owned by Ola",
            glance: "1 waiting for Ola",
            host: { name: "the office server", kind: "own" },
            agents: [
                { task: "Q3 report export", state: "working", stateLabel: "Working" },
                { task: "Onboarding page", state: "waiting", stateLabel: "Waiting for Ola" },
            ],
            files: ["portal/, a git repository"],
            keys: ["Acme's Google sign-in", "Acme's GitHub sign-in"],
            reaches: [
                { id: "drive", name: "Google Drive", line: "Acme's account" },
                { id: "github", name: "GitHub", line: "Acme's organisation" },
            ],
            peek: {
                title: "Ola's work sandbox, shared with you",
                body: "It runs on the office server and reaches Acme's Drive and Acme's GitHub. That GitHub is a second sign-in, held by this sandbox, which your other sandboxes never see.",
            },
        },
    ],
    peeks: {
        you: {
            title: "Sign in anywhere, as one account",
            body: "Each screen only shows the board. Close it and nothing stops: the agents carry on, and the next screen you open shows the same sandboxes where you left them.",
            facts: [
                { label: "Browser", value: "on any computer" },
                { label: "Desktop app", value: "Windows and Linux" },
                { label: "Phone", value: "the same board, with a notice when an agent needs you" },
                { label: "Intentic OS", value: "a machine that boots straight into it" },
            ],
        },
        platform: {
            title: "intentic.dev knows the way, not the work",
            body: "When you open a sandbox, your screen reaches it through intentic's relay, down a tunnel the sandbox opened from its own side, so the machine it runs on needs no open port.",
            facts: [
                { label: "Holds", value: "your account, and where each of your sandboxes is" },
                { label: "Carries", value: "each request to its sandbox, through the relay" },
                { label: "Keeps", value: "none of your code, prompts or keys" },
            ],
        },
        laptop: {
            title: "One laptop, three jobs",
            body: "The same computer can be a screen you sign in from, the machine a sandbox runs on, and a tool that sandbox's agents use. Each is granted on its own, and having one never grants another.",
            facts: [
                { label: "A screen", value: "the desktop app you sign in from" },
                { label: "A machine", value: "Home runs on it" },
                { label: "A tool", value: "Home's agents use it, within the switches you set on the laptop" },
            ],
        },
        ola: {
            title: "Share a sandbox, not your account",
            body: "Ola owns the Acme portal and invited you to write in it. Each of you signs in as yourself, and the sandbox checks on every request who may do what. Her other sandboxes stay out of your sight, and yours out of hers.",
        },
        link: {
            title: "Linked sandboxes trade tasks, never keys",
            body: "Two of your own sandboxes can be linked, so an agent in Home can hand the game a task. The task runs over there, with that sandbox's files and sign-ins, and only its report comes back.",
        },
    },
    hint: "Select any part to look inside.",
    label: "You sign in once, from a browser, the desktop app on your laptop, your phone or Intentic OS. intentic.dev knows where each sandbox is, and its relay carries your screen's traffic to each one and keeps none of it. You are in three sandboxes. Home runs on your laptop and reaches your laptop, your phone and Home Assistant. Indie game runs on a machine intentic hosts and reaches a game server, GitHub and ElevenLabs. Acme portal is owned by your colleague Ola, runs on the office server, and reaches Acme's Google Drive and GitHub. Home and Indie game are linked. Ola signs in with her own account and reaches only the Acme portal. Agents work inside each sandbox.",
};
