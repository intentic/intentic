// Commit ids for the simulated graph (gitGraph.ts): forty hex characters, as git's are. Free of imports so the smoke's
// samples can name a seeded commit by the same id the page gives it.

/** Forty hex characters from a text: FNV-1a, five rounds with different offsets. */
export const shaOf = (text: string): string => {
    let sha = ``;
    for (let round = 0; round < 5; round += 1) {
        let hash = (0x811c9dc5 ^ Math.imul(round + 1, 0x9e3779b9)) >>> 0;
        for (const char of `${text}:${String(round)}`) {
            hash ^= char.charCodeAt(0);
            hash = Math.imul(hash, 0x01000193);
        }
        sha += (hash >>> 0).toString(16).padStart(8, `0`);
    }
    return sha;
};

/** A seeded commit's id (fixture/git/gitSeeds.ts): the same on every load, whichever repo is read first. */
export const seedSha = (repo: string, seed: string): string => shaOf(`seed:${repo}:${seed}`);

/** The n-th checkpoint's id (daemon/checkpoints.ts), shaped like the daemon's UUIDs and the same on every load. */
export const checkpointId = (n: number): string => {
    const hex = shaOf(`checkpoint:${String(n)}`);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
