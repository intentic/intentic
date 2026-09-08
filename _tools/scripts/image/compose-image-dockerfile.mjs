#!/usr/bin/env node
// Composes a Dockerfile for a profile: the core Dockerfile with each pack spliced at its marker, each followed by a RUN
// stamping the pack's content hash to /opt/packs/<name>, so a daemon knows what its base image already bakes. Placement
// (pre- or post-trees) is inferred from pack content, mirroring src/environment/packs.ts.
// packs:pre-trees pinned installs, above the tree COPYs
// packs:post-trees packs that read /opt/sandbox or COPY --from=trees
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

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

// Fragment verbatim, then a stamp RUN; hash is sha256 of the trimmed content, matching packs.ts's, or a baked pack
// reads as not baked.
const section = (name) => {
    const content = readFileSync(join(packsDir, `${name}.Dockerfile`), "utf8").trim();
    const hash = createHash("sha256").update(content).digest("hex");
    return {
        postTrees: content.includes("/opt/sandbox") || content.includes("--from=trees"),
        text: [`# ---- pack: ${name} ----`, content, `RUN mkdir -p /opt/packs && printf '%s' '${hash}' > /opt/packs/${name}`].join("\n"),
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
lines = splice(
    lines,
    PRE_MARKER,
    sections.filter((entry) => !entry.postTrees).map((entry) => entry.text),
);
process.stdout.write(lines.join("\n"));
