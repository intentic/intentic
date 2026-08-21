#!/usr/bin/env node
// Compose a sandbox image Dockerfile for a profile: the core Dockerfile (_sandbox/sandbox/Dockerfile) with
// each of the profile's feature packs (packs/<name>.Dockerfile: the SAME fragments the daemon composes into
// the environment overlay on demand, see src/environment/packs.ts) spliced at its marker line, each followed
// by a stamp RUN writing the pack's content hash to /opt/packs/<name>: how a running daemon knows what its
// base image bakes, and therefore which fragments an overlay still needs.
//
//   node _tools/scripts/compose-image-dockerfile.mjs <profile>     # composed Dockerfile on stdout
//
// Profiles live in packs/profiles.json. The `core` profile is empty: composing it returns the core
// Dockerfile unchanged. Two splice points, matching how the core file orders its layers:
//   packs:pre-trees   pinned installs, ABOVE the tree COPYs (a source change never evicts a pack download)
//   packs:post-trees  packs that read the daemon tree (/opt/sandbox) or COPY from the `trees` context
// Placement is inferred from pack content: the same inference packs.ts uses, so it cannot rot.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

const root = repoRoot(import.meta.url);
const packsDir = join(root, "_sandbox/sandbox/packs");
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

// One spliced section per pack: the fragment verbatim, then the base stamp. The hash is sha256 of the TRIMMED
// content: identical to packs.ts's, or the daemon would see every baked pack as "not baked" and re-propose it.
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
// Post-trees first: splicing pre-trees first would shift the post marker's index, and order between the two
// marker searches must not matter.
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
