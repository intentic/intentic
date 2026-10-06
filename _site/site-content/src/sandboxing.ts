// The words of /docs/sandboxing/: the four boxes a piece of agent work sits inside, from the outside in. The page and
// `SandboxingFigure.astro` both read from here, so the figure's captions and the prose under it can't drift apart.
//
// Each layer says what it contains AND what enforces it. A diagram of nested boxes reads as "walls all the way down"
// unless something says which lines are walls and which are lanes. `lanes` covers that, and the page shows it in
// full rather than as a footnote.

/** One of the four nested layers, outermost first. */
export interface SandboxingLayer {
    /** The figure's step key and the page fragment its tab links to. */
    id: "machine" | "sandbox" | "area" | "agent";
    /** The step's short name on the figure's tab. */
    tab: string;
    /** One line: what this layer is for. */
    title: string;
    /** The longer statement, shown under the figure while the step is lit and as the section's opening on the page. */
    body: string;
    /** Three things it holds, short enough to sit on one row. */
    holds: readonly string[];
    /** What keeps the edge of this layer, in one clause. */
    keptBy: string;
}

export interface SandboxingScene {
    heading: string;
    sub: string;
    layers: readonly SandboxingLayer[];
    /** What a reader should NOT conclude from the nesting. */
    lanes: readonly { heading: string; body: string }[];
    /** Spoken equivalent of the whole figure, for a reader who never sees it. Must name all four layers. */
    label: string;
}

export const sandboxingScene: SandboxingScene = {
    heading: "Four boxes, outside in",
    sub: "Every agent turn runs inside four boxes nested one in another. Each box is cut from the one around it and can never be wider.",
    layers: [
        {
            id: "machine",
            tab: "Machine",
            title: "A machine runs your sandboxes",
            body: "Your laptop, a server you rent, or a machine we host. It runs Docker and provides processors, memory and disk. One machine runs several sandboxes side by side, and they share nothing: each has its own container and its own volumes.",
            holds: ["Your device or ours", "Docker", "Several sandboxes"],
            keptBy: "Docker: separate containers, separate volumes",
        },
        {
            id: "sandbox",
            tab: "Sandbox",
            title: "A sandbox is one project's space",
            body: "One container where people and agents work on the same problem in the same environment. Its image decides which tools exist, so every turn finds the same ones. The sandbox grows its own environment: an agent proposes a tool, the owner approves it, and it becomes part of the image. Repositories live on /work and the record on /history, so both survive updates.",
            holds: ["Repositories on /work", "Tools, skills, extensions", "Accounts and personas"],
            keptBy: "the container, and the daemon inside it",
        },
        {
            id: "area",
            tab: "Area",
            title: "Each person holds an area",
            body: "An area is a named set of folders. Access gives each person a tier and the areas they hold; holding no area means the whole workspace. The daemon checks every file listing, read, write and search a person makes against it. The personas a person may pick are the ones homed inside their area, each with its own accounts and powers; a guest talks only through those.",
            holds: ["Named folders", "Personas homed there", "A tier: what they may do"],
            keptBy: "the daemon, on every request",
        },
        {
            id: "agent",
            tab: "Agent",
            title: "An agent works with its person's access",
            body: "A conversation takes the areas of whoever started it and keeps them from its first turn. A persona can narrow that further, never widen it. Each turn then runs in a box of its own inside the sandbox: an unprivileged user, its own processes, and a filesystem built from the folders it holds and the tools it needs, with no git history. The daemon commits its work to the conversation's own branch, where it waits until someone allowed to land it does.",
            holds: ["Its starter's areas", "Narrowed by its persona", "Its own branch"],
            keptBy: "a per-turn sandbox: its own user, its own processes, only its folders on disk",
        },
    ],
    lanes: [
        {
            heading: "The sandbox is the wall. An area is a lane.",
            body: "Two sandboxes are separate containers with separate files, and nothing in one can reach the other. Areas divide one sandbox between people who work together. A person's requests are refused outside their area, and their agent's turn runs with nothing else of the tree on disk, so even a command the agent writes itself finds nothing of the rest there. What an area doesn't split yet is the network: a fenced turn shares the sandbox's, including services other conversations run on it, such as a dev server or a database. If someone must never see the rest of a workspace, give them a sandbox of their own that holds only what they may see.",
        },
        {
            heading: "The sandbox's own configuration is never in an area",
            body: "No area can include the sandbox's settings or its public outbox. So a grant below maintainer can never reach the files that decide what agents may do, who is invited, or what gets published.",
        },
        {
            heading: "Maintainers and the owner are not fenced",
            body: "A maintainer holds the owner's operating authority: they read every credential and can drive every conversation. A folder fence on that tier would only be a line on a screen, so the daemon refuses to set one.",
        },
    ],
    label:
        "Four nested boxes. The machine runs Docker and holds several sandboxes that share nothing. " +
        "A sandbox is one project's container: its repositories, the tools its image provides, its accounts and personas, shared by the people and agents working in it. " +
        "Inside it each person holds an area, a named set of folders plus the personas homed in them, enforced by the daemon on every request. " +
        "An agent works with the access of the person who started its conversation: each turn runs in its own box holding only that person's folders, and its work waits on its own branch until it is landed.",
};
