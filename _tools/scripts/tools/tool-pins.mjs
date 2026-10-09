// WHERE EACH PINNED TOOL IN THE SANDBOX IMAGE IS WRITTEN, once: the binaries and CLIs the core Dockerfile, its packs and
// the CI base image fetch at a fixed version. The bumper writes through this table and the `tool-pins` check reads it,
// so a site listed here cannot be moved by one and forgotten by the other (the engines' own table, engine-pins.mjs, is
// the same idea for the agent engines and owns the reading and writing both use).
//
// A pin is more than its version where the download is checked: ripgrep, jq and gh carry a sha256 per architecture,
// cloudflared's container image a digest. Those are DERIVED from the version (`derive`), fetched by the bumper and
// written in the same pass, because a version moved without its checksum fails the image build, and a checksum moved
// by hand is a number nobody checked.
//
// What is deliberately NOT here, and why each stays a person's bump:
//   - Debian packages (git, curl, python3, ffmpeg…): trixie's, floating within the release on purpose. Their security
//     fixes arrive as `+deb13uN` revisions with the version number unchanged; leaving trixie for a newer upstream
//     number is a different decision from a bump.
//   - node-gyp: tracks the headers of the Node it compiles against, so it moves with the node base image.
//   - @posthog/cli: its pin decides which tool names the posthog skill's commands resolve to, which no test here reads.
//   - the agent engines: engines.json and _tools/scripts/engines own those.
// Everything here is plain file reading until `derive`, which is the only part that needs the network.

import { createHash } from "node:crypto";
import { readPin, rewrite, writePin } from "../engines/engine-pins.mjs";

export { rewrite };

const DOCKERFILE = "_sandbox/sandbox/Dockerfile";
const CI_BASE = "_tools/ci-base/Dockerfile";
const pack = (name) => `_sandbox/sandbox/image-packs/${name}.Dockerfile`;

// A pin site, as engine-pins.mjs reads it: one file, one pattern whose sole capture is the value, the exact number of
// matches, and which value it carries: `version`, or one of the tool's derived values.
const site = (file, pattern, count, carries = "version") => ({ file, pattern, count, carries });

// The default soak for a tool: how long a release must have been published before the bumper takes it. Longer than the
// engines' six hours because nothing here is waiting on a model release; a build tool's bad release is usually found
// and replaced within a few days, and three days costs nothing.
export const DEFAULT_SOAK_HOURS = 72;

const TIMEOUT_MS = 120_000;

// The sha256 of what a URL serves, or undefined when it could not be fetched. Hashing the bytes rather than reading a
// checksums file keeps every tool on one path whatever its release publishes, and is what the image build verifies.
export const sha256Of = async (url) => {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) {
            return undefined;
        }
        return createHash("sha256")
            .update(Buffer.from(await response.arrayBuffer()))
            .digest("hex");
    } catch {
        return undefined;
    }
};

// The multi-arch index digest Docker Hub serves for a tag, which is what a `name:tag@sha256:…` reference pins.
export const dockerHubDigest = async (repository, tag) => {
    try {
        const auth = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const { token } = await auth.json();
        const response = await fetch(`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`, {
            method: "HEAD",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
                authorization: `Bearer ${token}`,
                accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
            },
        });
        const digest = response.headers.get("docker-content-digest");
        return response.ok && /^sha256:[a-f0-9]{64}$/.test(digest ?? "") ? digest.slice("sha256:".length) : undefined;
    } catch {
        return undefined;
    }
};

// Every `package version` pair one Debian Packages index lists.
const aptIndex = async (url) => {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) {
            return undefined;
        }
        const pairs = new Set();
        for (const stanza of (await response.text()).split("\n\n")) {
            const name = stanza.match(/^Package: (\S+)$/m)?.[1];
            const version = stanza.match(/^Version: (\S+)$/m)?.[1];
            if (name !== undefined && version !== undefined) {
                pairs.add(`${name} ${version}`);
            }
        }
        return pairs;
    } catch {
        return undefined;
    }
};

const DOCKER_ARCHES = ["amd64", "arm64"];
const dockerAptVersion = (version) => `5:${version}-1~debian.13~trixie`;

// Docker tags a release on GitHub before its apt repository serves the packages, and the pack installs from the
// repository: a pin the repository cannot resolve fails the build. Undefined when both architectures carry the engine
// and its CLI at this version, otherwise the sentence saying what is missing.
const dockerAptMissing = async (version) => {
    for (const arch of DOCKER_ARCHES) {
        const index = await aptIndex(`https://download.docker.com/linux/debian/dists/trixie/stable/binary-${arch}/Packages`);
        if (index === undefined) {
            return `download.docker.com could not be read for ${arch}`;
        }
        for (const name of ["docker-ce", "docker-ce-cli"]) {
            if (!index.has(`${name} ${dockerAptVersion(version)}`)) {
                return `download.docker.com does not serve ${name} ${dockerAptVersion(version)} for ${arch} yet`;
            }
        }
    }
    return undefined;
};

// Both architectures' checksums for one download, keyed the way the sites name them; undefined if either failed.
const checksums = async (urlFor) => {
    const amd64 = await sha256Of(urlFor("amd64"));
    const arm64 = await sha256Of(urlFor("arm64"));
    return amd64 === undefined || arm64 === undefined ? undefined : { "sha256:amd64": amd64, "sha256:arm64": arm64 };
};

const RG_TARGET = { amd64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" };

// The per-architecture checksum sites in the core Dockerfile's `case "$arch"` blocks, one pattern per arch.
const shaSites = (variable) =>
    ["amd64", "arm64"].map((arch) => site(DOCKERFILE, new RegExp(`\\b${arch}\\)[^\\n]*?\\b${variable}=([a-f0-9]{64})`, "g"), 1, `sha256:${arch}`));

// `withinMajor` holds a tool to its current major version: a major move of these changes defaults (Docker's engine
// API, pnpm's lockfile) that are worth a person reading the release notes for, and the bumper says it is waiting.
export const TOOL_PINS = [
    {
        id: "ripgrep",
        label: "ripgrep",
        upstream: { kind: "github-release", repo: "BurntSushi/ripgrep" },
        sites: [site(DOCKERFILE, /^ARG RIPGREP_VERSION=(\S+)$/gm, 1), ...shaSites("rg_sha")],
        derive: (version) =>
            checksums((arch) => `https://github.com/BurntSushi/ripgrep/releases/download/${version}/ripgrep-${version}-${RG_TARGET[arch]}.tar.gz`),
    },
    {
        id: "jq",
        label: "jq",
        upstream: { kind: "github-release", repo: "jqlang/jq", tagPrefix: "jq-" },
        sites: [site(DOCKERFILE, /^ARG JQ_VERSION=(\S+)$/gm, 1), ...shaSites("jq_sha")],
        derive: (version) => checksums((arch) => `https://github.com/jqlang/jq/releases/download/jq-${version}/jq-linux-${arch}`),
    },
    {
        id: "yq",
        label: "yq",
        upstream: { kind: "github-release", repo: "mikefarah/yq" },
        sites: [site(DOCKERFILE, /^ARG YQ_VERSION=(\S+)$/gm, 1)],
    },
    {
        id: "gh",
        label: "GitHub CLI",
        upstream: { kind: "github-release", repo: "cli/cli" },
        sites: [site(DOCKERFILE, /^ARG GH_VERSION=(\S+)$/gm, 1), ...shaSites("gh_sha")],
        derive: (version) => checksums((arch) => `https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_${arch}.tar.gz`),
    },
    {
        id: "cloudflared",
        label: "cloudflared",
        // The binary the image bakes and `ic` installs, and the container image the deploy graph, the self-host compose
        // and the Windows host one-liner run: one upstream, moved together, or a user's tunnel and their sandbox's
        // cloudflared are different builds (which is how three versions were once live at once).
        upstream: { kind: "github-release", repo: "cloudflare/cloudflared" },
        sites: [
            site(DOCKERFILE, /^ARG CLOUDFLARED_VERSION=(\S+)$/gm, 1),
            site("_sandbox/ic/src/machine/enroll.rs", /"CLOUDFLARED_VERSION"[^\n]*?"(\d{4}\.\d+\.\d+)"/g, 1),
            site("_sandbox/ic/src/sandbox/connect.rs", /"CLOUDFLARED_VERSION"[^\n]*?"(\d{4}\.\d+\.\d+)"/g, 1),
            ...[
                "_deploy/state-resolver/src/lib/images.ts",
                "_deploy/sdk/src/__fixtures__/deploy.graph.ts",
                "_tools/selfhost/platform/docker-compose.yml",
                // Already on 2026.10.0 when the rest were on 2026.9.3: moved by hand, alone, which is the drift this
                // table exists to stop.
                "_tools/turbo-cache/docker-compose.yml",
                "_site/site/public/scripts/connect-host.ps1",
            ].flatMap((file) => [
                site(file, /cloudflare\/cloudflared:(\d{4}\.\d+\.\d+)@sha256:[a-f0-9]{64}/g, 1),
                site(file, /cloudflare\/cloudflared:\d{4}\.\d+\.\d+@sha256:([a-f0-9]{64})/g, 1, "digest"),
            ]),
        ],
        derive: async (version) => {
            const digest = await dockerHubDigest("cloudflare/cloudflared", version);
            return digest === undefined ? undefined : { digest };
        },
    },
    {
        id: "uv",
        label: "uv",
        upstream: { kind: "github-release", repo: "astral-sh/uv" },
        sites: [site(pack("python"), /^RUN version=(\S+) \\$/gm, 1)],
    },
    {
        id: "ruff",
        label: "ruff",
        // The sandbox's per-edit python check and CI's copy of it run the same ruff, so the suite proves the parser.
        upstream: { kind: "github-release", repo: "astral-sh/ruff" },
        sites: [site(pack("python"), /ruff_version=(\S+) \\$/gm, 1), site(CI_BASE, /ruff_version=(\S+) \\$/gm, 1)],
    },
    {
        id: "pyright",
        label: "pyright",
        // `--outputjson` is a wire format the daemon parses; its integration suite runs CI's copy, held to the pack's.
        upstream: { kind: "npm", package: "pyright" },
        sites: [site(pack("python"), /pyright@(\S+) /g, 1), site(CI_BASE, /pyright@(\S+) /g, 1)],
    },
    {
        id: "pnpm",
        label: "pnpm",
        upstream: { kind: "npm", package: "pnpm" },
        withinMajor: true,
        sites: [
            site("package.json", /"packageManager": "pnpm@([^"]+)"/g, 1),
            site("package.json", /^ {8}"pnpm": "([^"]+)"$/gm, 1),
            site("_tools/extension-example/seed/package.json", /"packageManager": "pnpm@([^"]+)"/g, 1),
            site(DOCKERFILE, /PNPM_VERSION=(\S+) /g, 1),
            site(CI_BASE, /PNPM_VERSION=(\S+) /g, 1),
        ],
    },
    {
        id: "docker",
        label: "Docker Engine",
        upstream: { kind: "github-release", repo: "moby/moby", tagPrefix: "docker-v" },
        withinMajor: true,
        sites: [site(pack("docker"), /^ARG DOCKER_VERSION=(\S+)$/gm, 1)],
        available: dockerAptMissing,
    },
];

export const toolPin = (id) => TOOL_PINS.find((tool) => tool.id === id);

// What this checkout pins for one tool: its version, every derived value, and every site that disagreed.
// readPin also answers the engines' `tracked`/`blessed` pair, which a tool has no sites for.
export const readToolPin = (tool) => Object.fromEntries(Object.entries(readPin(tool)).filter(([key]) => key !== "tracked" && key !== "blessed"));

export const readToolPins = () => Object.fromEntries(TOOL_PINS.map((tool) => [tool.id, readToolPin(tool)]));

// Writes a version and its derived values into every site, refusing (before any file is touched) when a site matched
// the wrong number of times.
export const writeToolPin = (tool, values) => writePin(tool, values);
