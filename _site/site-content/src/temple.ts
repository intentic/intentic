// The words of the home page's build plate, and there are deliberately few of them: the picture is the argument and
// this file is its caption. Three stages — the stone you bring, the site where the work happens, the temple that goes
// up — and the three things that never leave your hands.
//
// NO MECHANISMS HERE. Branches, worktrees, terminals, sandboxes and diffs are all true and all named elsewhere on the
// page; this band is the one telling of the shape of the deal, and a reader meeting the product for the first time
// cannot hold a noun they have not been given. `TempleFigure.astro` holds the drawing; the provider marks on the
// quarry stones are read from the cost band's own account list, so the two can never name different providers.

/** One stage of the build: the word under its part of the scene, and the single line that says what it is. */
export interface TempleStage {
    label: string;
    line: string;
}

/** One thing you keep. Three of them, and each is a verb you do, not a feature the product has. */
export interface TempleControl {
    label: string;
    /** Key into the figure's icon table. A key with no drawing renders no icon. */
    icon: "direct" | "watch" | "approve";
}

export interface TempleScene {
    eyebrow: string;
    heading: string;
    sub: string;
    stone: TempleStage;
    site: TempleStage & { controls: TempleControl[] };
    temple: TempleStage;
    /** Spoken equivalent of the whole picture; must carry the stone, the work, the temple and all three verbs. */
    label: string;
}

export const templeScene: TempleScene = {
    eyebrow: "How it works",
    // Two beats, and the second one is the offer: you are not the one lifting stone.
    heading: "You bring the stone. The agents build.",
    sub: "Nothing is set in place without your word.",
    stone: { label: "Stone", line: "The AI plans you already pay for." },
    site: {
        label: "The site",
        // "Keeps the yard in order" is the whole of the machinery a first-time reader needs: work happens, and
        // something is keeping it from becoming a mess.
        line: "Agents do the work. intentic keeps the yard in order.",
        controls: [
            { label: "You direct", icon: "direct" },
            { label: "You watch", icon: "watch" },
            { label: "You approve", icon: "approve" },
        ],
    },
    temple: { label: "The temple", line: "Your software, standing." },
    label:
        "A building site. The AI plans you already pay for are the stone. Agents carry it and set it, on a site intentic keeps in order, " +
        "while you watch from the terrace. What goes up is your software. You direct the work, you can see all of it, and nothing is set in place until you approve it.",
};
