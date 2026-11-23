import { execFileSync } from "node:child_process";
import semanticRelease from "semantic-release";
import { decide, heldMessage, intervalMinutes } from "./release-hold.mjs";

/* Compute the version before an artifact is built, and hold it back while the last release is younger than
   RELEASE_MIN_INTERVAL_MINUTES (release-hold.mjs says why). Writes `version=` (empty: release nothing) and `held=`
   (the notice the plan job shows, empty when nothing was held) for $GITHUB_OUTPUT. */
const result = await semanticRelease(
    { dryRun: true },
    {
        cwd: process.cwd(),
        env: process.env,
        stdout: process.stderr,
        stderr: process.stderr,
    },
);

const planned = result === false ? `` : result.nextRelease.version;
const lastTag = result === false ? undefined : result.lastRelease?.gitTag;
const minutes = intervalMinutes(process.env.RELEASE_MIN_INTERVAL_MINUTES);

// When the previous release went out: its GitHub Release's publication, the moment publish-github.sh made it, else the
// tag's own date (a lightweight tag's is its commit's, which is earlier, so the hold only ever comes out shorter).
const releasedAt = async (tag) => {
    const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_API_URL: api = `https://api.github.com` } = process.env;
    if (token && repo) {
        try {
            const response = await fetch(`${api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
                headers: { Authorization: `Bearer ${token}`, Accept: `application/vnd.github+json` },
                signal: AbortSignal.timeout(15_000),
            });
            const at = response.ok ? Date.parse((await response.json()).published_at ?? ``) : Number.NaN;
            if (Number.isFinite(at)) {
                return at;
            }
        } catch {
            // allow(silent-catch): an unreachable API falls back to the tag's date below, which is never later
        }
    }
    try {
        const seconds = Number(execFileSync(`git`, [`for-each-ref`, `--format=%(creatordate:unix)`, `refs/tags/${tag}`], { encoding: `utf8` }).trim());
        return seconds > 0 ? seconds * 1000 : undefined;
    } catch {
        // allow(silent-catch): a tag this clone cannot date holds nothing back, as no interval at all would
        return undefined;
    }
};

const verdict =
    planned === `` || minutes <= 0 || lastTag === undefined
        ? { version: planned, held: false }
        : decide({ version: planned, lastReleasedAt: await releasedAt(lastTag), now: Date.now(), minutes });

process.stdout.write(`version=${verdict.version}\n`);
process.stdout.write(`held=${verdict.held ? heldMessage({ version: planned, until: verdict.until, lastTag, minutes }) : ``}\n`);
