/* THE ONE TASK THAT NEEDS NO CODE, what the empty agent board offers a user whose workspace has nothing in
 * it yet. Every other suggestion in this product is evidence-driven (the starters read the repos, the
 * capability recommendations read the remotes), so an empty box makes all of them silent at once; building
 * something is the only suggestion such a user can press and get an artifact from.
 *
 * WHAT THE EXAMPLES ARE FOR, and why they are these. A blank box asking "what should I build?" is a test the
 * user did not revise for, and the common answer to one is to leave. Each of these is pressable in one click,
 * and each is deliberately from a different world, a business page, a personal page, a toy, so the row reads
 * as "anything" rather than as three variations on a landing page.
 *
 * They FILL the chat's composer rather than sending, like every other starter on the board: a suggestion the
 * user has not edited yet is not a task they asked for, and the edit is what makes it theirs. */
export interface BuildIdea {
    readonly label: string;
    readonly idea: string;
}

export const BUILD_IDEAS: readonly BuildIdea[] = [
    {
        label: `A page for my business`,
        idea: `A one-page site for a small coffee roastery, what we sell, where to find us, and how to get in touch.`,
    },
    { label: `A personal profile`, idea: `A personal homepage for me, a short introduction, what I work on, and links to find me elsewhere.` },
    { label: `Something playful`, idea: `A single-page browser game I can play with the keyboard, with a score and a restart button.` },
];

/* THE TASK, WRITTEN ONCE. Every constraint here exists to keep a first build fast and unable to fail in a way
 * the user would read as the product being broken:
 *   · ONE self-contained file, no install step, so nothing depends on a network or a lockfile
 *   · in `public/`, live the moment it is written, with no server to start and no port to bind
 *   · no repository, no package.json, the workspace stays clean for whoever came here with real work
 *   · no questions first, a first run that opens with a clarifying question has shown nothing yet
 * The last paragraph is not decoration: this directory is served to anyone with the link, and the agent
 * writing into it should know that as plainly as the user does. The built page shows up as the "Public site"
 * target in the Preview area, which is where the user watches it land. */
export const buildPrompt = (idea: string): string =>
    [
        `Build me a small website: ${idea.trim()}`,
        ``,
        `Do it exactly this way, and don't ask me anything first, just build it:`,
        `1. Write ONE self-contained page to \`public/index.html\` at the workspace root. Inline the CSS and any JavaScript. No build step, no dependencies, no external files, no images that have to be fetched.`,
        `2. Make it genuinely good-looking: a clear headline, a considered colour palette, generous spacing, and real copy written for this specific idea, never lorem ipsum. It must read well on a phone.`,
        `3. Don't create a repository, a package.json, or a dev server. The single file is the whole job.`,
        `4. When the file is written, stop and tell me it's live.`,
        ``,
        `Everything under \`public/\` is served on the open internet at this sandbox's public address, so keep it to content that is fine for anyone to see.`,
    ].join(`\n`);
