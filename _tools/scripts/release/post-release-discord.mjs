#!/usr/bin/env node
/* Post a release highlight to the community Discord #announcements webhook.
 *
 *   DISCORD_RELEASE_WEBHOOK=https://discord.com/api/webhooks/… node _tools/scripts/release/post-release-discord.mjs 1.234.0
 *   DRY_RUN=1 …   # print the exact message that would be posted, post nothing
 *   FORCE=1 …     # post even when the release has no user-facing notes
 *
 * Reads the published GitHub Release body and quotes the same "## What's new" / "## Breaking changes" sections
 * the site changelog and the sandbox update card use — not the commit-subject list below them. That spelling
 * is a contract across four files that share no dependency edge, and the `release-headings` check
 * (_tools/checks/release-headings.mjs) is the only thing that notices when one of them drifts.
 *
 * WHY THE `success` STEP AND NOT publishCmd. .releaserc.json runs this after mark-release-cut.sh, which is the
 * only point where a release is finished rather than in progress: publishCmd is still stitching image
 * manifests and has not flipped make_latest yet (ship-stable.sh), so announcing from inside it would tell the
 * community about a version that `releases/latest/download` does not serve and that a later failure can leave
 * half-shipped. A Discord message cannot be un-sent the way a pointer can be rolled back.
 *
 * Skips quietly when the release has no user-facing notes (internal-only ship), unless FORCE=1 — roughly half
 * of this repository's releases are invisible to users and posting them would train people to mute the
 * channel. A failed post is never fatal: the release already shipped, and failing here would report a red
 * pipeline for a green release.
 *
 * WHY THIS IS JAVASCRIPT. It was a bash script that shelled out to `node` five times — to read two fields off
 * a JSON body, to run a heredoc'd program that extracted the sections, to count a message in characters rather
 * than bytes (`head -c` cuts a multi-byte character in half and leaves invalid UTF-8 in the payload), and to
 * build the payload itself. Every hard part was already JavaScript and only the two HTTP calls were shell, and
 * both of those are one `fetch`. */

const version = process.argv[2];
if (version === undefined) {
    console.error("usage: post-release-discord.mjs <version>");
    process.exit(2);
}

const repo = process.env.GITHUB_REPOSITORY ?? "intentic/intentic";
const tag = `v${version}`;
const webhook = process.env.DISCORD_RELEASE_WEBHOOK ?? "";
const force = process.env.FORCE === "1";
const dryRun = process.env.DRY_RUN === "1";
const limit = Number(process.env.DISCORD_RELEASE_BULLET_LIMIT ?? "8");

if (webhook === "") {
    console.log("  skip     discord release post (no DISCORD_RELEASE_WEBHOOK)");
    process.exit(0);
}

// Unauthenticated where no token is set: the Release being read is public, and this runs from a maintainer
// machine as readily as from the release job.
const release = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(process.env.GITHUB_TOKEN === undefined ? {} : { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
    },
}).catch(() => undefined);
if (release === undefined || !release.ok) {
    console.error(`  skip     discord release post (release ${tag} not found)`);
    process.exit(0);
}
const { body = "", html_url: htmlUrl } = await release.json();

/* The bullets under one "## " heading, in the shape publish-github.sh emits: `- ` items until the next heading
 * of any level, which is where the commit-subject list ("### Features") begins. Its own copy of the walk, like
 * the daemon's and the site's, for the reason those two state — no dependency edge joins these four files —
 * and held to the same spelling by the release-headings check. */
const sectionBullets = (label) => {
    const heading = new RegExp(String.raw`^##\s+${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*$`, "i");
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((line) => heading.test(line.trim()));
    if (start === -1) {
        return [];
    }
    const bullets = [];
    for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) {
            break;
        }
        if (trimmed.startsWith("- ")) {
            bullets.push(trimmed.slice(2).trim());
        }
    }
    return bullets.filter(Boolean);
};

const breaking = sectionBullets("Breaking changes");
const notes = sectionBullets("What's new");

if (breaking.length === 0 && notes.length === 0 && !force) {
    console.log(`  skip     discord release post (${tag} has no user-facing notes)`);
    process.exit(0);
}

// Capped, with the overflow named rather than dropped: a release with thirty notes is a link to the full ones.
const formatBullets = (bullets) => {
    const shown = bullets.slice(0, limit).map((line) => `• ${line}`);
    const extra = bullets.length - shown.length;
    return extra > 0 ? [...shown, `_…and ${extra} more in the full release notes._`] : shown;
};

const releaseUrl = htmlUrl ?? `https://github.com/${repo}/releases/tag/${tag}`;
const content = [
    `🚀 **intentic ${tag}**`,
    "",
    ...(breaking.length > 0 ? ["⚠️ **Breaking changes**", ...formatBullets(breaking), ""] : []),
    ...(notes.length > 0 ? ["**What's new**", ...formatBullets(notes), ""] : []),
    `📦 [Release notes](${releaseUrl}) · [Changelog](https://intentic.dev/changelog)`,
].join("\n");

// Discord caps a message at 2000 CHARACTERS, counted the way JavaScript counts them rather than in bytes.
// flags 4 = SUPPRESS_EMBEDS: without it the two trailing links unfurl into preview cards twice the height of
// the notes themselves.
const payload = { content: content.length > 2000 ? `${content.slice(0, 1999)}…` : content, flags: 4 };

if (dryRun) {
    console.log(payload.content);
    process.exit(0);
}

const posted = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
}).catch(() => undefined);
if (posted === undefined || !posted.ok) {
    console.error("  warn     discord release post failed (non-fatal)");
    process.exit(0);
}
console.log(`  posted   discord release ${tag}`);
