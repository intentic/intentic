// The three ways a project gets into the workspace, as the pure halves the page and its tests share: the brief a new
// project's assistant is given, and the name a clone lands under.

// Runs in the shared tree, not a private copy: a new repository made inside a worktree is outside land (worktrees.ts),
// so it would never reach the workspace.
export const newProjectBrief = (sentence: string): string =>
    [
        `Start a new project in this workspace from this description:`,
        ``,
        sentence.trim(),
        ``,
        `Make a new folder for it at the workspace root, named after the project in lowercase with hyphens, and run \`git init\` inside it.`,
        `Write a README.md whose first paragraph says in one sentence what the project is, then set up whatever the description needs so that it can be looked at right away.`,
        `When you are done, say what you made and what to look at first, in plain words.`,
    ].join(`\n`);

// A conversation id the daemon accepts and a person can read back: the moment it started, plus enough randomness
// that two presses in one second do not collide.
export const newProjectConversationId = (now: number, random: number = Math.random()): string =>
    `project-${now.toString(36)}-${Math.floor(random * 36 ** 4)
        .toString(36)
        .padStart(4, `0`)}`;

// A conversation's title from its sentence: the first line, cut to what the registry allows.
export const titleOf = (sentence: string): string => {
    const line = sentence.split(`\n`).find((candidate) => candidate.trim() !== ``)?.trim() ?? `New project`;
    return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
};

// The folder a clone lands in: the address's last segment without `.git`; empty when the address has none.
export const repoNameFromUrl = (url: string): string => {
    const trimmed = url.trim().replace(/\/+$/, ``);
    const tail = trimmed.split(/[/:]/).at(-1) ?? ``;
    return tail.replace(/\.git$/i, ``);
};
