import type { GitRunner } from "./runner.js";

// DURABLE GIT WRITES (2026-11-03). A host that loses power (rog, 10-30 15:00: Windows crashed under WSL2) kept the
// names of the files git had written but not their contents: 45 loose objects and refs/stash came back all NUL, the
// right size, and the next land failed on "inflate: data stream error". Git's default fsyncs packs but not loose
// objects, refs or the index, so the very writes a turn makes most were the ones the crash took. `all` is every
// component (loose objects, packs and their indexes, commit-graph, refs, the index): naming fewer would also drop the
// pack metadata git syncs by default, since setting the key replaces the default rather than adding to it. `batch`
// syncs a command's loose objects with one flush at its end instead of one per object, which is what keeps an
// `add -A` over thousands of files cheap. Git older than 2.37 warns once about `batch` and syncs per object.
export const GIT_DURABILITY_CONFIG = [
    ["core.fsync", "all"],
    ["core.fsyncMethod", "batch"],
] as const;

// The same pairs as `-c` flags, for every git the daemon's runner starts in any repository.
export const GIT_DURABILITY_ARGS: readonly string[] = GIT_DURABILITY_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]);

/**
 * Writes the durability settings into a repository's own config, so a terminal's or an agent's git (which never sees the
 * daemon's `-c` flags) syncs its writes too. `--local` lands them in the shared git dir every worktree reads. A key
 * already set to the value costs one read and no write.
 */
export const persistGitDurability = async (repoDir: string, git: GitRunner): Promise<void> => {
    for (const [key, value] of GIT_DURABILITY_CONFIG) {
        // allow(silent-catch): an absent key exits 1, which reads as "not set yet" and is written below.
        const current = await git(repoDir, ["config", "--local", "--get", key]).catch(() => undefined);
        if (current?.stdout.trim() !== value) {
            await git(repoDir, ["config", "--local", key, value]);
        }
    }
};

// Git's words for an object or index it cannot read back: a loose object that will not inflate (the 10-30 crash's
// "inflate: data stream error … loose object ff5612cb… is corrupt"), one left empty, an index whose bytes are gone.
// These say the repository's storage is damaged, which no retry and no rebase changes; a missing object a checkout
// never had ("bad object", "unknown revision") is a different failure and is not matched here.
// allow(dependency-text): git's stderr wording; the daemon's git runs untranslated, so it is git's English.
const GIT_CORRUPTION = /\bis corrupt\b|unable to unpack [0-9a-f]+|inflate: data stream error|object file \S+ is empty|index file corrupt|bad signature 0x[0-9a-f]+/iu;

/** Whether git's message says the repository's own storage is damaged. */
export const isGitCorruption = (said: string): boolean => GIT_CORRUPTION.test(said);

let corruptionListener: ((dir: string, said: string) => void) | undefined;

/** Called with every git the runner starts that fails on damaged storage; the daemon sets it at boot to start a repair. */
export const onGitCorruption = (listener: ((dir: string, said: string) => void) | undefined): void => {
    corruptionListener = listener;
};

/** The runner's report of a failed git; a listener that throws is not the caller's failure. */
export const reportGitFailure = (dir: string, said: string | undefined): void => {
    if (corruptionListener === undefined || said === undefined || !isGitCorruption(said)) {
        return;
    }
    try {
        corruptionListener(dir, said);
    } catch {
        // allow(silent-catch): the listener only starts a background repair; the git failure itself still throws.
    }
};
