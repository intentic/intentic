import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot as findRepoRoot } from "@intentic/constants/node";
import { z } from "zod";

// HOW DEEP EACH PUBLISHED IMAGE IS. Docker's classic layer store registers no layer whose parent chain is already 125
// deep, so an image of more layers fails every pull on it: `failed to register layer: max depth exceeded`. 1.338.0's
// standard image was 127 (Dockerfile one COPY per CLI, plus the e-urzad, microsoft-365 and prawo copies) and failed the
// arm64 smoke while amd64, on the containerd store, pulled it. The budget sits below 125 by what an environment rebuild
// stacks on top (environment/environment.ts composes FROM this image): every capability fragment and approved tool is
// another RUN, and a rebuild that crosses the limit fails just as a pull does.
const DOCKER_MAX_DEPTH = 125;
const OVERLAY_ROOM = 15;
const BUDGET = DOCKER_MAX_DEPTH - OVERLAY_ROOM;
// What the base under `FROM node:<version>-trixie-slim` brings: Debian's one layer and the node image's four, read off
// the registry's manifest (1.338.0 measured 127 = 5 + the 122 its composed Dockerfile counted below).
const BASE_LAYERS = 5;

const repoRoot = findRepoRoot(import.meta.url);
const profiles = Object.keys(
    z
        .object({ profiles: z.record(z.string(), z.array(z.string())) })
        .parse(JSON.parse(readFileSync(join(repoRoot, "_sandbox/sandbox/image-packs/profiles.json"), "utf8"))).profiles,
);

// The instructions that each commit a layer in BuildKit's image, in the stage that ships (the last FROM). Every one
// starts a line: a continuation is indented, and the Dockerfile carries no heredoc whose body could start one.
const layersOf = (dockerfile: string): number => {
    const shipped = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    return shipped.split("\n").filter((line) => /^(RUN|COPY|ADD|WORKDIR) /.test(line)).length;
};

test("every profile is composed and counted, the standard one among them", () => {
    expect(profiles).toEqual(expect.arrayContaining(["core", "standard"]));
});

test.each(profiles)("the %s image leaves an environment rebuild room under Docker's layer limit", (profile) => {
    const composed = execFileSync("node", ["_tools/scripts/image/compose-image-dockerfile.mjs", profile], { cwd: repoRoot, encoding: "utf8" });
    const layers = BASE_LAYERS + layersOf(composed);
    expect(layers, `${profile}: ${layers} layers, over the budget of ${BUDGET} (merge COPYs that share a mode and a directory)`).toBeLessThanOrEqual(
        BUDGET,
    );
});
