// The words of /docs/worksite/: four nouns a reader meets everywhere else in the docs, each given a picture to hang on.
// `WorksiteFigure.astro` draws them; this file is the only place they are worded.
//
// THE PRODUCT WORD ALWAYS LEADS. The worksite is a gloss and never a synonym: messaging.md licenses no second word for
// "sandbox", and a figure that renamed one would undo that everywhere it is read. Every `literal` below therefore has
// to survive its `drawnAs` being deleted, and `limits` is the part of the drawing that is not true.

/** One labelled part: the product's noun, the part of the worksite it is drawn as, and what it is with no worksite in it. */
export interface WorksitePart {
    /** The figure's highlight key, and the fragment its hotspot links to. */
    id: "machine" | "sandbox" | "persona" | "project";
    /** The product's own word, as the docs and the app write it. */
    word: string;
    /** What it is drawn as. Goes in the hotspot's second line, never on its own. */
    drawnAs: string;
    /** The single line that carries the metaphor. One sentence, because the drawing is doing the work. */
    gloss: string;
    /** The same thing with no worksite in the sentence. This is the definition; the gloss is the mnemonic. */
    literal: string;
    /** Three things it actually contains, short enough to sit in a row. */
    holds: readonly string[];
    /** The page that owns this word in full. */
    href: string;
    page: string;
}

export interface WorksiteScene {
    heading: string;
    sub: string;
    parts: readonly WorksitePart[];
    /** Where the drawing stops being true. Stated on the page, not in a footnote: the metaphor over-claims without it. */
    limits: readonly { heading: string; body: string }[];
    /** Spoken equivalent of the whole drawing, for a reader who never sees it. Must name all four parts. */
    label: string;
}

export const worksiteScene: WorksiteScene = {
    heading: "One camp, many workers",
    sub: "Four words the rest of these docs use as though you had them.",
    parts: [
        {
            id: "machine",
            word: "The machine",
            drawnAs: "the camp",
            gloss: "Ground, a wall and a fire. A camp holds a crew and decides nothing about what they build.",
            literal:
                "The computer the whole thing runs on: your laptop, a server you rent, or a machine we host for you. It supplies processors, memory and disk, and that is its entire job. Moving to a bigger one changes how fast your agents work and nothing else about them.",
            holds: ["Processors, memory, disk", "Docker", "Several sandboxes at once"],
            href: "/where-it-runs/",
            page: "Where it runs",
        },
        {
            id: "sandbox",
            word: "A sandbox",
            drawnAs: "a worker in the camp",
            gloss: "Each worker keeps a bay of their own, a belt of their own and a kit the next worker has no key to.",
            literal:
                "One workspace with everything an agent needs inside it: your repositories, its tools, its credentials, its terminals and the running agent itself. It is a Docker container plus durable volumes, so the work carries on after you close the browser. One machine carries several, and they are strangers to each other.",
            holds: ["Its own repositories", "Its own tools and credentials", "Many conversations at once"],
            href: "/docs/architecture/",
            page: "Architecture",
        },
        {
            id: "persona",
            word: "A persona",
            drawnAs: "the assignment",
            gloss: "The board a worker takes for a shift: which trade, whose keys, which building it reports to.",
            literal:
                "A card you write that decides what a conversation is and may do: which tools are mounted, which accounts it signs in as, which folder it starts in, which instructions it runs on. What a persona withholds is not switched off somewhere the agent can see. It is simply not there that turn.",
            holds: ["Tools and accounts", "The folder it works in", "Its own instructions"],
            href: "/docs/autonomous-employees/#another-sandbox-or-another-persona",
            page: "Autonomous employees",
        },
        {
            id: "project",
            word: "A project",
            drawnAs: "a construction",
            gloss: "It stands in the open, worked by whoever is put on it, and owned by none of them.",
            literal:
                "A repository in the workspace. No conversation owns one: every agent in that sandbox can reach it, each working on a branch of its own, and the same project can sit in two sandboxes at once because each keeps its own clone. Git is what reconciles them, and you read the diff before any of it joins your tree.",
            holds: ["Your code, in git", "A branch per agent", "Read before it lands"],
            href: "/docs/parallel-agents/",
            page: "Parallel agents",
        },
    ],
    limits: [
        {
            heading: "No worker lends a tool",
            body: "Two sandboxes in one camp share the hardware and nothing else. Separate containers, separate volumes, separate credentials: neither can read the other's files, and removing one leaves the other untouched. A real crew passes tools across the yard all day. This one has no way to.",
        },
        {
            heading: "A worker can move to another camp",
            body: "Export a sandbox as a definition and the same workspace comes back up on a different machine, keeping its address and its name: the same hut, the same belt, the same keys, on ground it has never stood on. Nobody walks into a strange camp and finds their own bench waiting, and it is the more useful half of the truth: the machine is the part you are least tied to.",
        },
        {
            heading: "One worker is on several jobs at once",
            body: "A sandbox runs many conversations at the same time, each with its own branch, its own terminal and its own half-finished thought. One body on a scaffold cannot do that, and it is where the picture is thinnest: if the number has to be right, read a worker as a workshop with a crew inside it rather than as one pair of hands.",
        },
        {
            heading: "Nobody in the camp is the foreman",
            body: "The camp is hardware and the workers do what they are put on. Direction comes from you, and every change a worker makes arrives as a diff you read before it joins your tree. An agent that wants something its assignment does not carry asks you, rather than fetching it.",
        },
    ],
    label:
        "A carved relief of a building camp. The wall around it, the gate through it, the yard floor and the fire standing in the yard are the "
        + "machine your work runs on: ground, power and disk, deciding nothing. Inside the wall each sandbox is a worker in a bay of its own, with a "
        + "locked kit at its feet that no other bay has a key to. The board hanging in each bay is its persona: the assignment written on it, the "
        + "tools it carries as filled pegs beside the empty ones it left off, and a line out to the building it reports to. The buildings rising "
        + "beyond the wall are your projects — one with two workers on it at once, one with nobody, and one still pegged out on the ground.",
};
