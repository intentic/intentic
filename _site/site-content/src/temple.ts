// The words of the home page's build plate, and there are deliberately few of them: the picture is the argument and
// this file is its caption. Three stages — the stone you bring, the site where the work happens, the temple that goes
// up — and the three things intentic keeps in order at the site.
//
// NO MECHANISMS HERE. Branches, worktrees, terminals, sandboxes and diffs are all true and all named elsewhere on the
// page; this band is the one telling of the shape of the deal, and a reader meeting the product for the first time
// cannot hold a noun they have not been given. `TempleFigure.astro` holds the drawing; the provider marks the crew
// wear are read from the cost band's own account list, so the two can never name different providers.
//
// The stone is the reader's OWN material and the marks are on the agents, never the other way round: a model is not
// something a building is made of, and a band that draws the providers as the stone is making the cost band's
// argument four bands early, in a picture that promised to make none.

/** One stage of the build: the word under its part of the scene, and the single line that says what it is. */
export interface TempleStage {
    label: string;
    line: string;
}

/** One thing intentic guarantees at the site. Three of them, each a benefit the yard delivers. */
export interface TempleControl {
    label: string;
    /** Key into the figure's icon table. A key with no drawing renders no icon. */
    icon: "tokens" | "safety" | "aligned";
}

export interface TempleScene {
    eyebrow: string;
    heading: string;
    sub: string;
    stone: TempleStage;
    site: TempleStage & { controls: TempleControl[] };
    temple: TempleStage;
    /** Spoken equivalent of the whole picture; must carry the stone, the work, the temple and all three site guarantees. */
    label: string;
}

export const templeScene: TempleScene = {
    eyebrow: "How it works",
    // Two beats, and the second one is the offer: you are not the one lifting stone.
    heading: "You bring the stone. The agents build.",
    sub: "Nothing is set in place without your word.",
    stone: { label: "Stone", line: "Your code, your documents, your words." },
    site: {
        label: "The site",
        // "Keeps the yard in order" is the whole of the machinery a first-time reader needs: work happens, and
        // something is keeping it from becoming a mess.
        line: "Agents do the work. intentic keeps the yard in order.",
        controls: [
            { label: "Save 38% on tokens", icon: "tokens" },
            { label: "Stay safe", icon: "safety" },
            { label: "Agents stay aligned", icon: "aligned" },
        ],
    },
    temple: { label: "The temple", line: "Your software, standing." },
    label:
        "A building site. The stone is what you bring: your code, your documents, your words, each block carved with what it is. " +
        "Agents cut it, carry it and set it, each one marked with the AI model behind it, on a site intentic keeps in order, while you watch from the terrace. " +
        "What goes up is your software. intentic saves thirty-eight percent on tokens, guards every turn, and keeps agents aligned.",
};
