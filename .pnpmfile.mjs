// Dependency-graph surgery pnpm's declarative settings can't express. Forces a full re-resolution on
// change and is invisible to Renovate.

const readPackage = (pkg) => {
    // Unused optional peer: mediaplex decodes voice directly, but it pulls in vulnerable tar via node-pre-gyp.
    if (pkg.name === "prism-media") {
        delete pkg.peerDependencies?.["@discordjs/opus"];
        delete pkg.peerDependenciesMeta?.["@discordjs/opus"];
    }
    return pkg;
};

export const hooks = { readPackage };
