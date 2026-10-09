// WHAT UPSTREAM HAS PUBLISHED, AND WHEN. The "when" is the whole reason this is not the abbreviated registry document
// the daemon reads: a soak window needs each version's publish time, and only the full packument carries it.
//
// Nothing here throws on a bad answer from the network. A registry that is down must read as "could not ask", which
// leaves the pin where it is; a version invented from a failed fetch would be blessed fleet-wide within the hour.

const TIMEOUT_MS = 30_000;

const getJson = async (url, headers = {}) => {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers });
        return response.ok ? await response.json() : undefined;
    } catch {
        return undefined;
    }
};

// A release candidate, canary or rc never gets blessed by machine; a human pins one deliberately instead.
const isStable = (version) => /^\d+(\.\d+)*$/.test(version);

const parts = (version) => version.split(".").map((piece) => Number(piece) || 0);

// Numeric component compare, longest wins on a tie (1.2.0 > 1.2). Only stable versions reach it, so there is no
// prerelease ordering to get wrong.
export const compareVersions = (left, right) => {
    const a = parts(left);
    const b = parts(right);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) {
            return difference < 0 ? -1 : 1;
        }
    }
    return 0;
};

export const isNewer = (candidate, than) => compareVersions(candidate, than) > 0;

const NPM = "https://registry.npmjs.org";

// Every stable version of an npm package with the time it was published. `time` also carries `created`/`modified`,
// which are not versions and are filtered out by the stability test.
const npmVersions = async (packageName) => {
    const body = await getJson(`${NPM}/${encodeURIComponent(packageName)}`);
    if (body === undefined) {
        return undefined;
    }
    const published = body.time ?? {};
    return Object.keys(body.versions ?? {})
        .filter((version) => isStable(version) && typeof published[version] === "string")
        .map((version) => ({ version, at: Date.parse(published[version]) }));
};

// One published manifest, for a pin derived from another package's dependency (codex).
export const npmManifest = (packageName, version) => getJson(`${NPM}/${encodeURIComponent(packageName)}/${version}`);

// A token lifts the anonymous 60-requests-an-hour limit; absent is fine for one repository's releases.
const githubHeaders = () => {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    return { accept: "application/vnd.github+json", ...(token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` }) };
};

// A tag is the version behind a prefix: `v` by default, or the repository's own (`jq-1.8.2`, moby's `docker-v29.9.0`).
// A tag without a declared prefix is some other artifact the repository releases (moby also tags its API module) and is
// skipped rather than read as a version.
export const versionOfTag = (tag, prefix) => {
    if (prefix === undefined) {
        return tag.replace(/^v/, "");
    }
    return tag.startsWith(prefix) ? tag.slice(prefix.length) : undefined;
};

const githubVersions = async (repo, tagPrefix) => {
    const body = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=100`, githubHeaders());
    if (!Array.isArray(body)) {
        return undefined;
    }
    return body
        .filter((release) => release.prerelease !== true && release.draft !== true && typeof release.published_at === "string")
        .map((release) => ({ version: versionOfTag(String(release.tag_name ?? ""), tagPrefix), at: Date.parse(release.published_at) }))
        .filter((release) => release.version !== undefined && isStable(release.version));
};

// Every stable version upstream publishes for one engine, newest last, or undefined when upstream could not be asked.
// `alsoPublished` intersects: a version only one of a pair of packages released is not a version this repo can pin,
// because the pack and the catalog have to name the same one.
export const publishedVersions = async (upstream) => {
    const primary = upstream.kind === "npm" ? await npmVersions(upstream.package) : await githubVersions(upstream.repo, upstream.tagPrefix);
    if (primary === undefined) {
        return undefined;
    }
    let allowed = primary;
    for (const companion of upstream.alsoPublished ?? []) {
        const theirs = await npmVersions(companion);
        if (theirs === undefined) {
            return undefined;
        }
        const known = new Set(theirs.map((entry) => entry.version));
        allowed = allowed.filter((entry) => known.has(entry.version));
    }
    return [...allowed].sort((left, right) => compareVersions(left.version, right.version));
};
