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
    /** The sign-in or pairing the sandbox holds for it, drawn as the key on the line to it. */
    via: string;
    /** What the agents do there, in two or three words. */
    does: string;
    laptop?: true;
}

/** A conversation running in a sandbox: the agent's task, and where it stands. */
export interface BigPictureAgent {
    task: string;
    state: "working" | "waiting" | "ready";
    stateLabel: string;
}

/** Every peek opens on a title and at most one short line; the drawing under it says the rest. */
export interface BigPicturePeekHead {
    title: string;
    line: string;
}

/** The peeks that are not a sandbox, each with the few words its drawing needs. */
export interface BigPicturePeeks {
    you: BigPicturePeekHead & { closed: string; working: string };
    platform: BigPicturePeekHead & {
        path: { screen: string; relay: string; relayNote: string; sandbox: string; sandboxNote: string; tunnel: string };
        facts: readonly { kind: "holds" | "routes" | "stores"; label: string; value: string }[];
    };
    laptop: BigPicturePeekHead & {
        jobs: readonly { id: "screen" | "machine" | "tool"; name: string; line: string; grantedBy: string }[];
        switches: readonly { name: string; on: boolean }[];
    };
    ola: BigPicturePeekHead & {
        accounts: readonly { who: string; key: string; role: string }[];
        apart: { yours: string; hers: string; label: string };
    };
    link: BigPicturePeekHead & { task: string; report: string; stays: string };
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
    /** The folders its agents work in, shown in the peek. */
    files: readonly string[];
    reaches: readonly BigPictureReach[];
    /** The one sentence under the peek's title. */
    line: string;
}

export interface BigPictureScene {
    you: { name: string; screens: string };
    kiosks: readonly BigPictureKiosk[];
    colleague: { name: string; line: string };
    /** The tagline is two short sentences, drawn one under the other. */
    platform: { name: string; tagline: readonly [string, string] };
    sandboxes: readonly BigPictureSandbox[];
    peeks: BigPicturePeeks;
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
            reaches: [
                { id: "laptop", name: "Your laptop", via: "Paired", does: "Commands and screen", laptop: true },
                { id: "phone", name: "Your phone", via: "Android app", does: "The apps you allow" },
                { id: "assistant", name: "Home Assistant", via: "MCP server", does: "Lights and heating" },
            ],
            line: "Uses your own devices, within the switches you set on each.",
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
            files: ["game/"],
            reaches: [
                { id: "server", name: "Game server", via: "SSH key", does: "Deploys builds" },
                { id: "github", name: "GitHub", via: "Your sign-in", does: "Pushes as you" },
                { id: "elevenlabs", name: "ElevenLabs", via: "API key", does: "Records voices" },
            ],
            line: "Runs in intentic's cloud, so it keeps going with your laptop shut.",
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
            files: ["portal/"],
            reaches: [
                { id: "drive", name: "Google Drive", via: "Acme sign-in", does: "Reports and docs" },
                { id: "github", name: "GitHub", via: "Acme sign-in", does: "Acme's repositories" },
            ],
            line: "Ola owns it and invited you to write in it.",
        },
    ],
    peeks: {
        you: {
            title: "One account, every screen",
            line: "Each screen shows the same board, with the same sandboxes in it.",
            closed: "Close the screen",
            working: "The agents keep working",
        },
        platform: {
            title: "intentic.dev knows the way, not the work",
            line: "Your screen reaches a sandbox through its relay, down a tunnel the sandbox opened.",
            path: {
                screen: "Your screen",
                relay: "Relay",
                relayNote: "routes, stores nothing",
                sandbox: "Your sandbox",
                sandboxNote: "no open port",
                tunnel: "dialled out by the sandbox",
            },
            facts: [
                { kind: "holds", label: "Holds", value: "Your account, and where each sandbox is" },
                { kind: "routes", label: "Routes", value: "Each request to its own sandbox" },
                { kind: "stores", label: "Stores", value: "None of your code, prompts or keys" },
            ],
        },
        laptop: {
            title: "One laptop, three jobs",
            line: "Each job is granted on its own. Having one never grants another.",
            jobs: [
                { id: "screen", name: "A screen", line: "You sign in on it", grantedBy: "Signing in" },
                { id: "machine", name: "A machine", line: "Home runs on it", grantedBy: "The desktop app" },
                { id: "tool", name: "A tool", line: "Home's agents use it", grantedBy: "Pairing it to Home" },
            ],
            switches: [
                { name: "Run commands", on: true },
                { name: "See the screen", on: true },
                { name: "Change files", on: false },
                { name: "Mouse and keyboard", on: false },
            ],
        },
        ola: {
            title: "Share a sandbox, not your account",
            line: "Each of you signs in as yourself, and the sandbox checks who may do what.",
            accounts: [
                { who: "Ola", key: "Her account", role: "Owner" },
                { who: "You", key: "Your account", role: "Writer" },
            ],
            apart: { yours: "Your Home and Indie game", hers: "Ola's other sandboxes", label: "out of each other's sight" },
        },
        link: {
            title: "Linked sandboxes trade tasks, never keys",
            line: "An agent in Home hands the game a task; it runs there, and only the report comes back.",
            task: "Task",
            report: "Report",
            stays: "Keys stay put",
        },
    },
    hint: "Select any part to look inside.",
    label: "You sign in once, from a browser, the desktop app on your laptop, your phone or Intentic OS. intentic.dev knows where each sandbox is, and its relay carries your screen's traffic to each one and keeps none of it. You are in three sandboxes. Home runs on your laptop and reaches your laptop, your phone and Home Assistant. Indie game runs on a machine intentic hosts and reaches a game server, GitHub and ElevenLabs. Acme portal is owned by your colleague Ola, runs on the office server, and reaches Acme's Google Drive and GitHub. Home and Indie game are linked. Ola signs in with her own account and reaches only the Acme portal. Agents work inside each sandbox.",
};
