#!/usr/bin/env node
// Posts a release's `## What's new`/`## Breaking changes` sections to the Discord webhook; the heading spelling is a
// contract release-headings.mjs checks. Runs at the `success` step, after the release ships, since a post can't be
// un-sent. Skips quietly with no user-facing notes unless `FORCE=1`; a failed post never fails the pipeline.
// DRY_RUN=1 print the message that would post, post nothing
// FORCE=1 post even with no user-facing notes

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

// Unauthenticated without a token; the Release is public and this runs from a maintainer machine too.
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

// Bullets under one `##` heading, up to the next heading of any level; its own copy of the walk, kept in step with the
// site and daemon by the release-headings check.
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

// Caps bullets; overflow becomes a link to the full notes instead of being dropped.
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

// Discord's 2000-character cap counts JS string length, not bytes; `flags: 4` suppresses link-preview embeds.
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
