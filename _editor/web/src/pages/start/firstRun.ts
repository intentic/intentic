import type { PublicFile } from "@intentic/sandbox-contract";

/* THE FIRST SIXTY SECONDS, as the pure half — what the opening screen offers, what it asks the agent for, and
 * how it reads the outbox to know the thing exists.
 *
 * WHY THERE IS A SCREEN HERE AT ALL. Setup used to end on the workspace, which on a fresh sandbox is a file
 * explorer with no files and a pane asking the user to go and fetch some. Every other surface was just as
 * quiet, and for a reason worth stating: every suggestion in this product is EVIDENCE-DRIVEN — the board's
 * starters read the repos, the capability recommendations read the remotes and the compose files — so a box
 * with nothing in it produces nothing to say. The product was therefore at its most silent at the one moment a
 * new user is deciding whether it can do anything. This screen is the answer: before asking for anything, show
 * one piece of work, done, at a URL they can open on their phone.
 *
 * WHY THE OUTBOX AND NOT A SCAFFOLDED APP. `public/` is served with no process in front of it, so a single
 * file written there is live the instant it lands — no install, no dev server, no port, nothing that can be
 * slow or fail on a first run. A scaffolded monorepo would prove the template works; one page built from the
 * user's own sentence proves the MODEL works, which is the thing in doubt. */

/* Seen-it is a fact about the PERSON, not about the box: someone who has already chosen (built something, or
 * said they had their own code) should not be asked again on their second sandbox. The screen re-checks the
 * live workspace anyway and stands down when there is already work there, so this flag can never strand
 * somebody on an offer that no longer applies. */
const STORAGE_KEY = `intentic-first-run-done`;

export const firstRunDone = (): boolean => {
    try {
        return localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
        // Storage may be unavailable (private mode). Offering the screen again is the harmless direction to
        // fail in — it is one click to leave, and the alternative is hiding the product's only demonstration.
        return false;
    }
};

export const markFirstRunDone = (): void => {
    try {
        localStorage.setItem(STORAGE_KEY, `1`);
    } catch {
        // Nothing to do: the screen still works, it will just be offered again next time.
    }
};

/* WHAT THE EXAMPLES ARE FOR, and why they are these. A blank box asking "what should I build?" is a test the
 * user did not revise for, and the common answer to one is to leave. Each of these is pressable in one click,
 * and each is deliberately from a different world — a business page, a personal page, a toy — so the row reads
 * as "anything" rather than as three variations on a landing page.
 *
 * They FILL the box rather than sending, for the same reason the board's starters do: a suggestion the user
 * has not edited yet is not a task they asked for, and the edit is what makes it theirs. */
export interface BuildIdea {
    readonly label: string;
    readonly idea: string;
}

export const BUILD_IDEAS: readonly BuildIdea[] = [
    { label: `A page for my business`, idea: `A one-page site for a small coffee roastery — what we sell, where to find us, and how to get in touch.` },
    { label: `A personal profile`, idea: `A personal homepage for me — a short introduction, what I work on, and links to find me elsewhere.` },
    { label: `Something playful`, idea: `A single-page browser game I can play with the keyboard, with a score and a restart button.` },
];

/* THE TASK, WRITTEN ONCE. Every constraint here exists to keep the first run fast and unable to fail in a way
 * the user would read as the product being broken:
 *   · ONE self-contained file — no install step, so nothing depends on a network or a lockfile
 *   · in `public/` — live the moment it is written, with no server to start and no port to bind
 *   · no repository, no package.json — the workspace stays clean for whoever came here with real work
 *   · no questions first — a first run that opens with a clarifying question has shown nothing yet
 * The last paragraph is not decoration: this directory is served to anyone with the link, and the agent
 * writing into it should know that as plainly as the user does. */
export const buildPrompt = (idea: string): string =>
    [
        `Build me a small website: ${idea.trim()}`,
        ``,
        `Do it exactly this way, and don't ask me anything first — just build it:`,
        `1. Write ONE self-contained page to \`public/index.html\` at the workspace root. Inline the CSS and any JavaScript. No build step, no dependencies, no external files, no images that have to be fetched.`,
        `2. Make it genuinely good-looking: a clear headline, a considered colour palette, generous spacing, and real copy written for this specific idea — never lorem ipsum. It must read well on a phone.`,
        `3. Don't create a repository, a package.json, or a dev server. The single file is the whole job.`,
        `4. When the file is written, stop and tell me it's live.`,
        ``,
        `Everything under \`public/\` is served on the open internet at this sandbox's public address, so keep it to content that is fine for anyone to see.`,
    ].join(`\n`);

/* WHAT THE SCREEN IS WAITING FOR, read off the outbox listing rather than off the agent's own account of
 * itself. A turn that says it wrote the file and did not is the exact failure this screen cannot afford to
 * repeat back to a new user, so the evidence is the served file or nothing.
 *
 * `index.html` wins because it is what the prompt asks for and what the outbox root resolves to; any other
 * served page is accepted behind it so an agent that reasonably named the file something else still lands. */
const isPage = (file: PublicFile): boolean => file.path.toLowerCase().endsWith(`.html`);

export const builtPage = (files: readonly PublicFile[]): PublicFile | undefined => {
    const served = files.filter((file) => file.blocked === undefined && isPage(file));
    return served.find((file) => file.path.toLowerCase() === `index.html`) ?? served[0];
};

/* A page that landed in the outbox and is NOT being served — the one outcome that would otherwise look
 * identical to nothing having happened. The guards refuse a file by name, by content or by size, and the
 * publisher is the only person who can be told why, so the screen says it rather than sitting on a spinner. */
export const blockedPage = (files: readonly PublicFile[]): PublicFile | undefined =>
    files.find((file) => file.blocked !== undefined && isPage(file));
