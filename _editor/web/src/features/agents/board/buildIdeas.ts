// The one suggestion an empty workspace can act on without existing code: three one-click examples from different
// worlds (business, personal, toy) rather than variations on one theme. Like every board starter, pressing one fills
// the composer rather than sending, so editing it is what makes it the user's own.
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

// The build prompt: one self-contained file in `public/`, no install step, no repository, no clarifying questions, so
// nothing can fail in a way that reads as broken. `public/` is served live at the sandbox's public address.
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
