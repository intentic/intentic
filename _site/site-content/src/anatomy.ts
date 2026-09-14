// The words of /docs/anatomy/: four nouns a reader meets everywhere else in the docs, each given a picture to hang on.
// `AnatomyFigure.astro` draws them; this file is the only place they are worded.
//
// THE PRODUCT WORD ALWAYS LEADS. The animal is a gloss and never a synonym: messaging.md licenses no second word for
// "sandbox", and a figure that renamed one would undo that everywhere it is read. Every `literal` below therefore has
// to survive its `creature` being deleted, and `limits` is the part of the drawing that is not true.

/** One labelled part: the product's noun, the part of the animal it is drawn as, and what it is with no animal in it. */
export interface AnatomyPart {
    /** The figure's highlight key, and the fragment its hotspot links to. */
    id: "machine" | "sandbox" | "persona" | "project";
    /** The product's own word, as the docs and the app write it. */
    word: string;
    /** What it is drawn as. Goes in the hotspot's second line, never on its own. */
    creature: string;
    /** The single line that carries the metaphor. One sentence, because the drawing is doing the work. */
    gloss: string;
    /** The same thing with no animal in the sentence. This is the definition; the gloss is the mnemonic. */
    literal: string;
    /** Three things it actually contains, short enough to sit in a row. */
    holds: readonly string[];
    /** The page that owns this word in full. */
    href: string;
    page: string;
}

export interface AnatomyScene {
    heading: string;
    sub: string;
    parts: readonly AnatomyPart[];
    /** Where the drawing stops being true. Stated on the page, not in a footnote: the metaphor over-claims without it. */
    limits: readonly { heading: string; body: string }[];
    /** Spoken equivalent of the whole drawing, for a reader who never sees it. Must name all four parts. */
    label: string;
}

export const anatomyScene: AnatomyScene = {
    heading: "One body, many brains",
    sub: "Four words the rest of these docs use as though you had them.",
    parts: [
        {
            id: "machine",
            word: "The machine",
            creature: "the body",
            gloss: "One body. It carries the arms and decides nothing.",
            literal:
                "The computer the whole thing runs on: your laptop, a server you rent, or a machine we host for you. It supplies processors, memory and disk, and that is its entire job. Moving to a bigger one changes how fast your agents work and nothing else about them.",
            holds: ["Processors, memory, disk", "Docker", "Several sandboxes at once"],
            href: "/where-it-runs/",
            page: "Where it runs",
        },
        {
            id: "sandbox",
            word: "A sandbox",
            creature: "an arm, with a brain of its own",
            gloss: "Most of an octopus's neurons sit in its arms. An arm keeps working while the head looks elsewhere.",
            literal:
                "One workspace with everything an agent needs inside it: your repositories, its tools, its credentials, its terminals and the running agent itself. It is a Docker container plus durable volumes, so the work carries on after you close the browser. One machine carries several, and they are strangers to each other.",
            holds: ["Its own repositories", "Its own tools and credentials", "Many conversations at once"],
            href: "/docs/architecture/",
            page: "Architecture",
        },
        {
            id: "persona",
            word: "A persona",
            creature: "the grip",
            gloss: "One arm holds a wrench and an egg differently, and puts down only the suckers it needs.",
            literal:
                "A card you write that decides what a conversation is and may do: which tools are mounted, which accounts it signs in as, which folder it starts in, which instructions it runs on. What a persona withholds is not switched off somewhere the agent can see. It is simply not there that turn.",
            holds: ["Tools and accounts", "The folder it works in", "Its own instructions"],
            href: "/docs/autonomous-employees/#another-sandbox-or-another-persona",
            page: "Autonomous employees",
        },
        {
            id: "project",
            word: "A project",
            creature: "what the arms reach for",
            gloss: "Set down on the floor, picked up by whichever arm needs it.",
            literal:
                "A repository in the workspace. No conversation owns one: every agent in that sandbox can reach it, each working on a branch of its own, and the same project can sit in two sandboxes at once because each keeps its own clone. Git is what reconciles them, and you read the diff before any of it joins your tree.",
            holds: ["Your code, in git", "A branch per agent", "Read before it lands"],
            href: "/docs/parallel-agents/",
            page: "Parallel agents",
        },
    ],
    limits: [
        {
            heading: "The arms share no bloodstream",
            body: "Two sandboxes on one machine share the hardware and nothing else. Separate containers, separate volumes, separate credentials: neither can read the other's files, and removing one leaves the other untouched. A real octopus is one animal. This is several, boarding together.",
        },
        {
            heading: "An arm can move to another body",
            body: "Export a sandbox as a definition and the same workspace comes back up on a different machine, keeping its address and its name. Nothing about the animal works that way, and it is the more useful half of the truth: the machine is the part you are least tied to.",
        },
        {
            heading: "The head is not the one deciding",
            body: "The body is hardware. Direction comes from you, and every change an arm makes arrives as a diff you read before it joins your tree. An agent that wants something outside what its persona holds asks you, rather than reaching.",
        },
    ],
    label:
        "A carved relief of an octopus. Its body is the machine your work runs on. Each arm is a sandbox with a brain of its own, "
        + "working on while the head looks elsewhere. A band partway down each arm is its persona, deciding how far that arm reaches "
        + "and which of its suckers are in use. The inscribed tablets on the floor beneath are your projects, which any arm can pick up.",
};
