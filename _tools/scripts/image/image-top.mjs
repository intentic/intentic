// THE IMAGE'S TOP, as an environment build replays it (ic, _sandbox/ic/src/sandbox/layered.rs). An overlay used to be
// built FROM the whole sandbox image, so every commit's daemon, which changes the image's digest, invalidated every one
// of its layers, and a sandbox re-ran its whole recipe on each update (rog, 2026-11-19: 16 minutes of a 30-minute
// rebuild). ic now builds it FROM the image's `tools` stage and puts the `runtime` stage back on top by copying its paths
// out of the image, so the recipe's layers stay cached while `tools` does. What it needs to do that rides the image as a
// label (no layer), composed here from the `runtime` stage of the composed Dockerfile:
// - `prelude`: the stage's ENV and WORKDIR, set before the recipe so it runs as it did on the whole image (LANG, the
//   telemetry opt-outs, the /work working directory);
// - `replay`: one `COPY --link --parents --from=sandbox-image` of every path the stage's COPYs write (ic names the whole
//   image `sandbox-image`), then its RUNs in order, then its other instructions (EXPOSE, ENTRYPOINT). One copy, so one
//   layer, and hard links inside each copied tree survive (they do not across trees: the starter is in `tools` for that);
// - `touches`, `commands`, `env`: what ic keeps the recipe off when it puts a step below the replay: the paths the top
//   writes, the commands its RUNs put in /usr/local/bin, and the variables its ENVs set. A step naming one stays above
//   the replay, with every step after it. The commands the top COPYs into /usr/local/bin relay to the running daemon,
//   so no build step can use them and they are not listed (their paths are).

import { basename, posix } from "node:path";

// The line between the image's two stages (the core Dockerfile says why).
export const RUNTIME_STAGE = "FROM tools AS runtime";

// The label carrying the replay, and the one naming the `tools` image (set at build time, build-sandbox-image.sh and
// publish-images.sh, since the stage's image exists only once built). ic reads both: _sandbox/ic/src/sandbox/layered.rs.
export const IMAGE_TOP_LABEL = "dev.intentic.image-top";
export const TOOLS_LABEL = "dev.intentic.tools";

const CONFIG_KEYWORDS = new Set(["EXPOSE", "ENTRYPOINT", "CMD", "LABEL", "STOPSIGNAL", "USER", "HEALTHCHECK"]);

// The instructions below the stage line, each with the comment block right above it. A comment inside a continued
// instruction is dropped, as Docker drops it.
const instructionsBelow = (lines) => {
    const at = lines.indexOf(RUNTIME_STAGE);
    if (at === -1) {
        throw new Error(`the composed Dockerfile has no "${RUNTIME_STAGE}" line`);
    }
    const found = [];
    let comments = [];
    for (let index = at + 1; index < lines.length; index += 1) {
        const trimmed = lines[index].trim();
        if (trimmed === "" || trimmed.startsWith("#")) {
            comments = trimmed === "" ? [] : [...comments, trimmed];
            continue;
        }
        const body = [lines[index]];
        while (body.at(-1).trimEnd().endsWith("\\") && index + 1 < lines.length) {
            index += 1;
            if (!lines[index].trim().startsWith("#")) {
                body.push(lines[index]);
            }
        }
        const text = body.join("\n").trim();
        const words = text.replaceAll(/\\\n/gu, " ").split(/\s+/u);
        found.push({ text, comments, keyword: words[0].toUpperCase(), words: words.slice(1) });
        comments = [];
    }
    return found;
};

// Directories the `tools` stage and a recipe write into too. The replay must never copy one whole: it would put the
// image's copy of every file in it back over what the recipe changed there (a newer `gh` in /usr/local/bin, say).
const SHARED = new Set(["/", "/bin", "/etc", "/lib", "/opt", "/root", "/sbin", "/usr", "/usr/bin", "/usr/lib", "/usr/local", "/usr/local/bin", "/usr/local/lib", "/usr/local/share", "/usr/share", "/var"]);

// The paths one COPY writes in the image. A static layer root (`--from=trees layers/<name>/ /`) names them in an
// `# image-top:` comment. A source into a destination ending in `/` lands under its own name when it is a file, and a
// directory's entries merge into the destination, so each entry is a path of its own; only the source itself can say
// which it is (`inspect(source, from)`: `{ entries }` for a directory, `{}` for a file, undefined when it cannot tell).
const copyPaths = ({ text, comments, words }, inspect) => {
    const flags = words.filter((word) => word.startsWith("--"));
    const args = words.filter((word) => !word.startsWith("--"));
    const from = flags.find((flag) => flag.startsWith("--from="))?.slice("--from=".length);
    const dest = args.at(-1);
    const sources = args.slice(0, -1);
    if (from === "trees" && sources.some((source) => source.startsWith("layers/"))) {
        const named = comments.flatMap((comment) => /^#\s*image-top:\s*(.+)$/u.exec(comment)?.[1].trim().split(/\s+/u) ?? []);
        if (named.length === 0) {
            throw new Error(`a static layer root below the stage line names no paths: add "# image-top: <path>..." above\n${text}`);
        }
        return named;
    }
    if (from !== undefined && from !== "trees") {
        throw new Error(`the runtime stage may COPY only from the trees context or the repository:\n${text}`);
    }
    return sources.flatMap((source) => {
        if (!dest.endsWith("/")) {
            return [dest];
        }
        const found = inspect(source, from);
        if (found === undefined) {
            throw new Error(`cannot tell whether ${source} is a file or a directory, which decides where it lands in ${dest}`);
        }
        return found.entries === undefined ? [posix.join(dest, basename(source))] : found.entries.map((entry) => posix.join(dest, entry));
    });
};

// The absolute paths a RUN writes outside what the copy carries: redirect targets, `ln -s` targets, `mkdir -p` paths.
const runWrites = (text) => {
    const flat = text.replaceAll(/\\\n/gu, " ");
    const redirects = [...flat.matchAll(/>>?\s*(\/[^\s;&|)]+)/gu)].map((match) => match[1]);
    const links = [...flat.matchAll(/\bln\s+-[sf]+\s+\S+\s+(\/[^\s;&|)]+)/gu)].map((match) => match[1]);
    const made = [...flat.matchAll(/\bmkdir\s+-p\s+((?:\/[^\s;&|)]+\s*)+)/gu)].flatMap((match) => match[1].trim().split(/\s+/u));
    return [...redirects, ...links, ...made];
};

// The variables an ENV sets (`ENV A=1 B=2`, continued or not).
const envNames = (words) => [...words.join(" ").matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/gu)].map((match) => match[1]);

// The instructions of the `runtime` stage sorted by what the replay does with each: the paths its COPYs write, its RUNs
// (and what they write), its ENV and WORKDIR, and its config, in order.
const sortedOut = (instructions, inspect) => {
    const out = { paths: [], runs: [], writes: [], prelude: [], env: [], config: [] };
    for (const instruction of instructions) {
        const { keyword, text, words } = instruction;
        if (keyword === "COPY") {
            out.paths.push(...copyPaths(instruction, inspect));
        } else if (keyword === "RUN") {
            out.runs.push(text);
            out.writes.push(...runWrites(text));
        } else if (keyword === "ENV" || keyword === "WORKDIR") {
            out.prelude.push(text);
            out.env.push(...(keyword === "ENV" ? envNames(words) : []));
        } else if (CONFIG_KEYWORDS.has(keyword)) {
            out.config.push(text);
        } else {
            throw new Error(`the runtime stage cannot be replayed onto an environment with ${keyword}:\n${text}`);
        }
    }
    return out;
};

// The paths one copy carries: none a shared directory, and none under another it already carries.
const copyRoots = (paths) => {
    const shared = paths.filter((path) => SHARED.has(path.replace(/\/+$/u, "") || "/"));
    if (shared.length > 0) {
        throw new Error(`the runtime stage writes ${shared.join(", ")} whole, which tools and a recipe share: COPY into a directory of its own`);
    }
    const sorted = [...new Set(paths)].toSorted();
    return sorted.filter((path) => !sorted.some((other) => path.startsWith(`${other}/`)));
};

// The replay of the composed Dockerfile's `runtime` stage. `inspect(source, from)` answers for a COPY source (from is
// "trees" or undefined for the repository): see copyPaths.
export const imageTop = (dockerfile, inspect) => {
    const { paths, runs, writes, prelude, env, config } = sortedOut(instructionsBelow(dockerfile.split("\n")), inspect);
    const roots = copyRoots(paths);
    return {
        format: 1,
        prelude: prelude.join("\n"),
        replay: [`COPY --link --parents --from=sandbox-image ${roots.join(" ")} /`, ...runs, ...config].join("\n"),
        touches: [...new Set([...roots, ...writes])].toSorted(),
        commands: [...new Set(writes.filter((path) => path.startsWith("/usr/local/bin/")).map((path) => basename(path)))].toSorted(),
        env: [...new Set(env)].toSorted(),
    };
};

// The LABEL line carrying it. In single quotes, which a Dockerfile takes literally, so the JSON carries no quote and no
// `$` of its own.
export const imageTopLabel = (top) =>
    `LABEL ${IMAGE_TOP_LABEL}='${JSON.stringify(top).replaceAll("'", String.raw`\u0027`).replaceAll("$", String.raw`\u0024`)}'`;
