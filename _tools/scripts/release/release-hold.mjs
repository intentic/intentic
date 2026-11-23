// Whether a planned release waits for the release interval. release-plan.mjs asks it after semantic-release's dry run.
// A green push used to cut a release every time: 179 attempts over 2026-10-16..11-23, about five a day, each ~75 runner
// minutes plus a pause of six fleet workers for the Windows smoke. RELEASE_MIN_INTERVAL_MINUTES (a repository variable,
// 180 in release.yml when unset there) spaces them out. A push inside the interval verifies as before and publishes the
// `latest` images, and its commits ride the next release. release-flush.yml dispatches CI for a release held at main's
// head once its interval is over, so a quiet evening does not strand the last commits until the next push.

/** The interval in minutes, or 0 (no hold) for an unset, empty, negative or unreadable value. */
export const intervalMinutes = (raw) => {
    const minutes = Number(raw);
    return raw !== undefined && raw !== "" && Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
};

/**
 * What the planner says: the version unchanged when nothing holds it, or no version and the moment the hold ends.
 * `lastReleasedAt` is the previous release's time in ms, undefined when there is none (the first release is never held).
 */
export const decide = ({ version, lastReleasedAt, now, minutes }) => {
    if (version === "" || minutes <= 0 || lastReleasedAt === undefined || !Number.isFinite(lastReleasedAt)) {
        return { version, held: false };
    }
    const until = lastReleasedAt + minutes * 60_000;
    return now < until ? { version: "", held: true, until } : { version, held: false };
};

/** The `Release held` notice's text. release-flush.mjs reads the time back out of it with `heldUntil`. */
export const heldMessage = ({ version, until, lastTag, minutes }) =>
    `${version} waits until ${new Date(until).toISOString()}, ${String(minutes)} minutes after ${lastTag} (RELEASE_MIN_INTERVAL_MINUTES); release-flush.yml dispatches CI for it then if no push has`;

/** The hold's end in ms from a `Release held` notice, or undefined when the text is not one. */
export const heldUntil = (message) => {
    const at = /waits until (\S+),/u.exec(message ?? "")?.[1];
    const ms = at === undefined ? Number.NaN : Date.parse(at);
    return Number.isFinite(ms) ? ms : undefined;
};
