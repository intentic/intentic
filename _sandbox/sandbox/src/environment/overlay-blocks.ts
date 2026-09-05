/* READING AN OVERLAY FRAGMENT THE WAY A PERSON WOULD, its name, what it is for, and which commands it puts on
 * PATH, so the Environment tab can show contents instead of a build recipe.
 *
 * Everything here is TEXT IN, FACTS OUT: no filesystem, no probing, no services. That is deliberate. Which
 * binaries a block installs and which sentence explains it are exactly the judgements that rot silently, so they
 * are derived in one place from content and pinned in a test, rather than being declared beside each fragment
 * where nothing would ever notice them going stale. It is the same reasoning packs.ts states for its own two
 * inferred properties.
 *
 * The one thing NOT inferred here is a version. A block's install line is a bad source for one, half of them
 * pin nothing at all (`bun`, `rustup --default-toolchain stable`), and a number that IS pinned still describes
 * what a rebuild would install rather than what the container currently has. So this module's job ends at
 * naming CANDIDATE commands; asking them their version is version-probe.ts's, and what comes back is the only
 * version anybody is shown. */

// How the daemon delimits the named blocks inside the custom section, one per thing the agent asked for, named
// after the draft file it came from (see environment.ts readDrafts).
const BLOCK_MARKER = /^#\s*----\s*(.+?)\s*----\s*$/;

export interface OverlayBlock {
    // The marker's name for a custom block; for a capability fragment, whatever its contributor is called.
    readonly name: string;
    // The block's lines, comments included.
    readonly body: string;
}

/* Split the custom section into the blocks the agent wrote. Text before the first marker is a block too, an
 * older custom section is one unnamed run of instructions, and dropping it would under-report the environment
 * rather than merely render it plainly. */
export const splitBlocks = (content: string): OverlayBlock[] => {
    const blocks: OverlayBlock[] = [];
    let name = "";
    let lines: string[] = [];
    const flush = (): void => {
        const body = lines.join("\n").trim();
        if (body !== "") {
            blocks.push({ name, body });
        }
        lines = [];
    };
    for (const line of content.split("\n")) {
        const marker = BLOCK_MARKER.exec(line);
        if (marker?.[1] !== undefined) {
            flush();
            name = marker[1];
            continue;
        }
        lines.push(line);
    }
    flush();
    return blocks;
};

// A comment line's text, or undefined for anything that is not one. `#` alone is a paragraph break, which is
// why an empty string is a meaningful answer and has to stay distinguishable from "not a comment".
const commentText = (line: string): string | undefined => {
    const trimmed = line.trim();
    return trimmed.startsWith("#") ? trimmed.replace(/^#+\s?/, "").trimEnd() : undefined;
};

// A comment addressed to the rebuild executors rather than to a reader (`# intentic:runtime --privileged`). It
// is a comment only because a Dockerfile has nowhere else to put it, and reading it as prose ends a sentence
// with "intentic:runtime --privileged".
const isDirective = (text: string): boolean => text.startsWith("intentic:");

/* THE FRAGMENT NAMING ITS OWN SOURCE, which earns its place in the file and not in this view. A capability
 * writes "docker capability: this directive grants dockerd the privileges it needs", because in a composed
 * Dockerfile nothing else says where a block came from, but the row is already titled `docker`, already
 * grouped under "From your capabilities", and already attributed, so the prefix is the same word a fourth
 * time. Anchored on the label the daemon knows, so prose that merely happens to start with a colon is left
 * alone. */
const withoutSource = (prose: string, source: string | undefined): string => {
    if (source === undefined) {
        return prose;
    }
    const prefix = /^(.{0,40}?):\s+/.exec(prose);
    if (prefix?.[1]?.toLowerCase().startsWith(source.toLowerCase()) !== true) {
        return prose;
    }
    const rest = prose.slice(prefix[0].length);
    return rest.charAt(0).toUpperCase() + rest.slice(1);
};

// A bullet keeps its own line; prose is unwrapped. Fragments are hard-wrapped at ~120 columns, so joining
// blindly would run a bulleted list into one unreadable sentence.
const isBullet = (text: string): boolean => /^[•*-]\s/.test(text) || /^\s+/.test(text);

/* THE BLOCK'S EXPLANATION, unwrapped into paragraphs. Only the comment lines ABOVE the first instruction count:
 * comments further down annotate individual commands ("same glibc rationale as…") and are notes to whoever
 * edits the recipe, not an explanation of what the thing is for.
 *
 * `source` is whatever the daemon already knows pulled the block in ("docker capability"), so an opening line
 * that names it can come off, see withoutSource. */
export const blockProse = (body: string, source?: string): string => {
    const paragraphs: string[] = [];
    let current: string[] = [];
    const flush = (): void => {
        if (current.length > 0) {
            paragraphs.push(current.join("\n"));
            current = [];
        }
    };
    for (const line of body.split("\n")) {
        const text = commentText(line);
        if (text === undefined) {
            break;
        }
        if (isDirective(text)) {
            continue;
        }
        if (text === "") {
            flush();
            continue;
        }
        const last = current.at(-1);
        if (last === undefined || isBullet(text) || isBullet(last)) {
            current.push(text);
            continue;
        }
        current[current.length - 1] = `${last} ${text}`;
    }
    flush();
    return withoutSource(paragraphs.join("\n\n"), source);
};

/* Abbreviations whose full stop does not end a sentence. Without these the one-line purpose truncates mid-clause
 * at the first "e.g.", which is where these fragments reach for an example most often. */
const ABBREVIATIONS = ["e.g", "i.e", "etc", "vs", "cf", "no", "approx"];

/* WHERE THE FIRST SENTENCE ENDS. A full stop counts only when what follows looks like a new sentence, which
 * keeps version numbers (`v1.9.1`), file names (`gyp_main.py`) and package specs (`playwright@1.62.1`) from
 * cutting the line in half. */
const firstSentenceEnd = (text: string): number => {
    for (const match of text.matchAll(/\.(?=\s|$)/g)) {
        const at = match.index;
        const before = text.slice(0, at);
        if (/\d$/.test(before) || ABBREVIATIONS.some((word) => before.toLowerCase().endsWith(word))) {
            continue;
        }
        return at + 1;
    }
    return -1;
};

/* THE ONE LINE THAT GOES ON THE ROW, the opening sentence, with a trailing parenthetical dropped.
 *
 * These explanations open with the point and then qualify it at length ("ffmpeg, encoding screen recordings
 * (Playwright records VP8/WebM; its bundled ffmpeg cannot encode H.264, so …)"). The qualification is worth
 * keeping and worth not leading with, so it stays in the prose behind the disclosure and the row gets the part
 * somebody reads. Same trade the Devices rows make with a machine's OS string. */
/* Beyond this, a "one-line purpose" is two or three lines of the row and stops being one. Not every opening
 * sentence is short, "The desktop app is a Tauri 2 shell, so its whole native half is Rust that nothing in this
 * image can compile: there is no cargo, no pkg-config, and no webview headers." is one sentence and three
 * clauses, so an over-long one is cut back to its first clause, which is the claim, and the clauses that
 * qualify it stay in the prose behind the disclosure with everything else. */
const PURPOSE_LIMIT = 130;

export const purposeOf = (prose: string): string | undefined => {
    const paragraph = prose.split("\n\n")[0]?.replace(/\n/g, " ").trim() ?? "";
    if (paragraph === "") {
        return undefined;
    }
    const end = firstSentenceEnd(paragraph);
    const sentence = end === -1 ? paragraph : paragraph.slice(0, end);
    // A trailing qualification is the commonest shape of all ("ffmpeg, encoding screen recordings (Playwright
    // records VP8/WebM …)"), and the row wants the part before it. Kept when dropping it leaves too little to
    // read, since a bare "Bun." is worse than a long line.
    const trimmed = sentence.replace(/\s*\([^()]*\)\s*\.?$/, ".").trim();
    const line = trimmed.length >= 25 ? trimmed : sentence.trim();
    if (line.length <= PURPOSE_LIMIT) {
        return line;
    }
    const clause = /^(.{25,}?)\s*[:;—]\s/.exec(line);
    return clause?.[1] === undefined ? line : `${clause[1]}.`;
};

/* WHAT THE DISCLOSURE SHOWS: the whole explanation, once, from the top.
 *
 * It used to be the REMAINDER, the prose with the row's line sliced off the front, which only works while the
 * two are cut from the same place. They are not: `purposeOf` drops a trailing parenthetical and cuts an
 * over-long sentence back to its first clause, so the remainder still began with the sentence the row was
 * showing, and the view (which stacks the row's line above the disclosure) printed the opening twice, once
 * trimmed and once whole. Slicing was the wrong half of the problem to solve, the reader who opens a row wants
 * the paragraph as it was written, and the row's line is a summary OF it rather than a first instalment of it.
 * So the disclosure is now the prose verbatim, and the view stops stacking. Nothing more than the row already
 * says ⇒ nothing to disclose. */
export const detailOf = (prose: string, purpose: string | undefined): string | undefined => {
    const whole = prose.trim();
    return whole === "" || whole === purpose ? undefined : whole;
};

// Everything below the leading comment, the commands themselves, for the reader who wants to see exactly what
// runs. Comments interleaved with the instructions stay: there they explain a specific line.
export const blockCommands = (body: string): string => {
    const lines = body.split("\n");
    const start = lines.findIndex((line) => commentText(line) === undefined && line.trim() !== "");
    return start === -1 ? "" : lines.slice(start).join("\n").trim();
};

// A word that could be a command name. Rules out flags, paths, shell operators and version specs.
const isCommandWord = (word: string): boolean => /^[a-z][a-z0-9+._-]*$/.test(word);

// A shell continuation makes one logical command span many lines, and an apt package list is the case that
// matters: matched line by line, a toolchain's eleven packages read as eleven unrelated words.
const unfold = (body: string): string => body.replace(/\\\n\s*/g, " ");

export interface BlockTools {
    // Commands worth asking for a version, best evidence first.
    readonly candidates: string[];
    // Every package the block installs. Whatever is left after the probing stage names the real commands is
    // plumbing, libraries, headers, meta-packages, and gets counted rather than listed.
    readonly packages: string[];
}

/* WHICH COMMANDS THIS BLOCK IS TRYING TO PUT ON PATH.
 *
 * Four kinds of evidence, and the first is much the strongest: a fragment that ends `&& bun --version` is
 * telling us both that `bun` is the point of it and that the build verified so. After that, an explicit install
 * into a bin directory names its own file; a global npm package's command is its last path segment; and an apt
 * package list is a weak signal that still catches the single-package blocks (`apt-get install ffmpeg`) which
 * are the most common shape of all. */
export const blockTools = (block: OverlayBlock): BlockTools => {
    const body = unfold(block.body);
    const candidates: string[] = [];
    const packages: string[] = [];
    const add = (word: string | undefined): void => {
        if (word !== undefined && isCommandWord(word) && !candidates.includes(word)) {
            candidates.push(word);
        }
    };

    // 1. The block's own verification calls.
    for (const match of body.matchAll(/(?:^|&&|\|\||;)\s*([a-z][a-z0-9+._-]*)\s+(?:--version|-version|version)\b/gm)) {
        add(match[1]);
    }
    // 2. A file installed into a bin directory, `install …/whisper-cli /usr/local/bin/whisper-cli`, `mv … /usr/local/bin/bun`.
    for (const match of body.matchAll(/(?:\/usr\/local\/bin|\/usr\/bin)\/([a-z][a-z0-9+._-]*)/g)) {
        add(match[1]);
    }
    // 3. A globally installed npm package: its command is the last segment (`@openai/codex` → `codex`).
    for (const match of body.matchAll(/npm\s+(?:install|i)\s+-g\s+((?:@[^\s@]+\/)?[^\s@]+)/g)) {
        add(match[1]?.split("/").at(-1));
    }
    // 4. The apt package list, a weak signal on its own, but it catches the single-package blocks
    //    (`apt-get install ffmpeg`) that are the most common shape there is. Stops at the next `&&` so the
    //    cleanup half of the same RUN contributes nothing.
    for (const match of body.matchAll(/apt-get\s+install\s+([^&\n]*)/g)) {
        for (const word of (match[1] ?? "").split(/\s+/)) {
            if (isCommandWord(word) && !packages.includes(word)) {
                packages.push(word);
                add(word);
            }
        }
    }
    // The name is a candidate too, and a good one: the agent named the draft file after what it wanted.
    add(block.name.toLowerCase());
    return { candidates, packages };
};
