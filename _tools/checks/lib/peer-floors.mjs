/* PEER FLOORS: the oldest release of each far end this tree still serves, read from the constant that holds it.

   A compat comment tag (`compat(daemon<x.y.z)` and a why) (compat-tags.mjs) and the release comparison of contract-shrink.mjs both
   name a peer from this list. A peer joins only once it has a floor of its own: a constant the code itself enforces
   (below it the far end is told to update), never one written here for the check's sake. Read by shape, since checks
   run before install. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./repo.mjs";

// id: the name a tag spells; file + constant: where the floor lives, as `export const NAME = "x.y.z"` (any quote).
// (2026-11-24) Only the daemon has one: the machine agent, the phone app, the browser extension and runners are
// served at every release they ever shipped, so none of them is a peer a tag can name yet.
const PEERS = [{ id: "daemon", file: "_shared/sandbox-contract/src/state/daemon-floor.ts", constant: "OLDEST_SUPPORTED_DAEMON" }];

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/u;

export const isRelease = (text) => RELEASE.test(text);

// Plain x.y.z ordering; both sides are released versions, so no pre-release part to weigh.
export const compareReleases = (a, b) => {
    const left = RELEASE.exec(a).slice(1).map(Number);
    const right = RELEASE.exec(b).slice(1).map(Number);
    for (const [index, part] of left.entries()) {
        if (part !== right[index]) {
            return part - right[index];
        }
    }
    return 0;
};

// Each peer's floor by id. Throws when a listed constant cannot be read: a check that silently lost its floor would
// vouch for every tag.
export const peerFloors = () =>
    new Map(
        PEERS.map(({ id, file, constant }) => {
            const text = readFileSync(join(root, file), "utf8");
            const version = new RegExp(String.raw`export const ${constant}\s*=\s*["'\x60](\d+\.\d+\.\d+)["'\x60]`, "u").exec(text)?.[1];
            if (version === undefined) {
                throw new Error(`${file}: no \`export const ${constant} = "x.y.z"\` to read the ${id} floor from`);
            }
            return [id, version];
        }),
    );
