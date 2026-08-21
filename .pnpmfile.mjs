/* Dependency-graph surgery that no declarative pnpm setting can express — keep it to exactly that, because this
 * file forces a full re-resolution whenever its checksum changes and is invisible to Renovate.
 *
 * `overrides` can only repoint a version and `packageExtensions` can only ADD manifest fields (the real manifest
 * wins the merge), so neither can take a dependency edge OUT of the graph. `ignoredOptionalDependencies` looks
 * like the tool for the job but walks `optionalDependencies` only — an optional PEER is untouched by it. A
 * readPackage hook is the one place a peer declaration can be deleted before resolution ever sees it.
 */

const readPackage = (pkg) => {
    /* Nothing here wants an Opus backend inside @discordjs/voice: the Discord gateway decodes received voice
     * with mediaplex directly (_extensions/discord/src/voice.ts) and never encodes, so voice's own decoder path
     * is dead code. @discordjs/opus was a direct dependency until mediaplex replaced it, and dropping that
     * dependency did not dislodge it — prism-media still declares it as an optional peer and pnpm still
     * resolves it, so it keeps pulling in @discordjs/node-pre-gyp → tar 6.2.1: twelve advisories, one of them
     * critical (GHSA-23hp-3jrh-7fpw), on the code path that untars an archive fetched over the network at
     * install time, plus a native compile on every install. node-pre-gyp 0.4.5 cannot take a tar 7 override, so
     * the only fix that holds is to stop the edge existing. prism-media names the peer in a string-literal
     * union and nowhere else in its typings, so removing it costs no types. */
    if (pkg.name === "prism-media") {
        delete pkg.peerDependencies?.["@discordjs/opus"];
        delete pkg.peerDependenciesMeta?.["@discordjs/opus"];
    }
    return pkg;
};

export const hooks = { readPackage };
