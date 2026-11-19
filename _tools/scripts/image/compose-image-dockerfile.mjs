#!/usr/bin/env node
// Composes a Dockerfile for a profile: the core Dockerfile with each pack spliced at its marker, each followed by a RUN
// stamping the pack's content hash to /opt/packs/<name>, so a daemon knows what its base image already bakes. Placement
// (pre- or post-trees) is inferred from pack content, mirroring src/image/packs.ts.
// packs:pre-trees pinned installs, above the tree COPYs
// packs:post-trees packs that read /opt/sandbox or COPY a per-commit tree --from=trees
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { imageTop, imageTopLabel, RUNTIME_STAGE } from "./image-top.mjs";

const root = repoRoot(import.meta.url);
const packsDir = join(root, "_sandbox/sandbox/image-packs");
const corePath = join(root, "_sandbox/sandbox/Dockerfile");

const PRE_MARKER = "# ---- packs:pre-trees ----";
const POST_MARKER = "# ---- packs:post-trees ----";

const profileName = process.argv[2];
if (profileName === undefined) {
    console.error("usage: compose-image-dockerfile.mjs <profile>");
    process.exit(2);
}

const profiles = JSON.parse(readFileSync(join(packsDir, "profiles.json"), "utf8")).profiles;
const profile = profiles[profileName];
if (profile === undefined) {
    console.error(`unknown profile "${profileName}", profiles.json defines: ${Object.keys(profiles).join(", ")}`);
    process.exit(2);
}
const known = new Set(
    readdirSync(packsDir)
        .filter((entry) => entry.endsWith(".Dockerfile"))
        .map((entry) => entry.slice(0, -".Dockerfile".length)),
);
const unknown = profile.filter((name) => !known.has(name));
if (unknown.length > 0) {
    console.error(`profile "${profileName}" names packs with no packs/<name>.Dockerfile: ${unknown.join(", ")}`);
    process.exit(2);
}

// A COPY from the trees context that is not a static layer root (`layers/<name>/`, built apart with --link and the same
// bytes on every commit): only those may splice above the per-commit trees. Comment lines do not count. Mirrors packs.ts.
const readsCommitTrees = (content) =>
    content.split("\n").some((line) => !line.trim().startsWith("#") && line.includes("--from=trees") && !/\slayers\//u.test(line));

// A COPY of a static layer root: built apart (--link), the same bytes from commit to commit.
const isStaticCopy = (instruction) =>
    /^\s*COPY\s[^\n]*--link[^\n]*--from=trees\s+layers\//u.test(instruction) ||
    /^\s*COPY\s[^\n]*--from=trees[^\n]*--link\s+layers\//u.test(instruction);

// A post-trees pack's static layer roots, each with the comment block written above it, taken out to splice ABOVE the
// per-commit trees with the pre-trees packs (messaging's third-party packages, beside its per-commit gateway trees): Docker's
// classic store re-downloads every layer above the first changed one, so a static layer below them is kept on an update.
// --link makes the layer independent of what sits under it, so moving it changes nothing it contains.
const hoistStatic = (content) => {
    const hoisted = [];
    const rest = [];
    let comments = [];
    const lines = content.split("\n");
    for (let at = 0; at < lines.length; at += 1) {
        const line = lines[at];
        if (line.trim().startsWith("#")) {
            comments.push(line);
            continue;
        }
        if (line.trim() === "") {
            rest.push(...comments, line);
            comments = [];
            continue;
        }
        const instruction = [line];
        while (instruction.at(-1).trimEnd().endsWith("\\") && at + 1 < lines.length) {
            at += 1;
            instruction.push(lines[at]);
        }
        (isStaticCopy(instruction.join("\n")) ? hoisted : rest).push(...comments, ...instruction);
        comments = [];
    }
    rest.push(...comments);
    return { hoisted: hoisted.join("\n"), rest: rest.join("\n").trim() };
};

// Fragment verbatim, then a stamp RUN; hash is sha256 of the trimmed content, matching packs.ts's, or a baked pack
// reads as not baked. A post-trees pack's static layer roots are split off to splice with the pre-trees packs.
const section = (name) => {
    const content = readFileSync(join(packsDir, `${name}.Dockerfile`), "utf8").trim();
    const hash = createHash("sha256").update(content).digest("hex");
    const postTrees = content.includes("/opt/sandbox") || readsCommitTrees(content);
    const { hoisted, rest } = postTrees ? hoistStatic(content) : { hoisted: "", rest: content };
    return {
        postTrees,
        hoisted: hoisted === "" ? undefined : [`# ---- pack: ${name}, its static layers (the rest splices below the trees) ----`, hoisted].join("\n"),
        text: [`# ---- pack: ${name} ----`, rest, `RUN mkdir -p /opt/packs && printf '%s' '${hash}' > /opt/packs/${name}`].join("\n"),
    };
};
const sections = profile.map(section);

const splice = (lines, marker, texts) => {
    const at = lines.findIndex((line) => line.startsWith(marker));
    if (at === -1) {
        console.error(`core Dockerfile has no "${marker}" marker line`);
        process.exit(2);
    }
    // After the marker's comment block (the marker line plus its continuation comment lines).
    let end = at + 1;
    while (end < lines.length && lines[end].startsWith("#")) {
        end += 1;
    }
    return [...lines.slice(0, end), ...texts.flatMap((text) => ["", text]), ...lines.slice(end)];
};

let lines = readFileSync(corePath, "utf8").split("\n");
// Post-trees first: splicing pre-trees first would shift the post marker's line index.
lines = splice(
    lines,
    POST_MARKER,
    sections.filter((entry) => entry.postTrees).map((entry) => entry.text),
);
// A post-trees pack's static layer roots go just below the stage line: the first layers of `runtime`, under every
// per-commit one, and out of `tools`, which they would move whenever their lockfile entries do.
lines = splice(
    lines,
    RUNTIME_STAGE,
    sections.flatMap((entry) => (entry.hoisted === undefined ? [] : [entry.hoisted])),
);
lines = splice(
    lines,
    PRE_MARKER,
    sections.filter((entry) => !entry.postTrees).map((entry) => entry.text),
);

// What an environment build replays of this image onto its `tools` stage (image-top.mjs says why and how). A COPY source
// is a file or a directory as the trees context or the repository has it, so both must be in place: prepare-image-trees.sh
// runs first wherever an image is built. Without the trees (composing only to read or count the Dockerfile, as
// image-layers.integration.test.ts does) the label is left out, and an image built so gets the classic overlay build.
// The core profile is never labelled: publish-images.sh builds the core image from the Dockerfile itself, so its
// composition stays that file unmodified.
const inspect = (source, from) => {
    const path = from === "trees" ? join(root, ".image-out", source) : join(root, source);
    if (!existsSync(path)) {
        return undefined;
    }
    return statSync(path).isDirectory() ? { entries: readdirSync(path).toSorted() } : {};
};
const composed = lines.join("\n");
if (profileName === "core") {
    process.stdout.write(composed);
} else if (existsSync(join(root, ".image-out"))) {
    const top = imageTopLabel(imageTop(composed, inspect));
    process.stdout.write(`${composed.trimEnd()}\n\n# What an environment build replays of this image onto \`tools\` (image-top.mjs).\n${top}\n`);
} else {
    console.error("compose-image-dockerfile: no .image-out, so the image-top label is left out (run prepare-image-trees.sh first to build)");
    process.stdout.write(composed);
}
