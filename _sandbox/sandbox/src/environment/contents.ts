import { existsSync } from "node:fs";
import type { EnvironmentContents, EnvironmentItem } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Services } from "../composition.js";
import { customPath, proposalPath } from "./environment.js";
import { blockCommands, blockProse, blockTools, detailOf, type OverlayBlock, purposeOf, splitBlocks, uniqueBlocks } from "./overlay-blocks.js";
import { listPacks } from "../image/packs.js";
import { privacyPackFragments } from "./privacy-pack.js";
import { probeAll, probeModules, probePackages } from "./version-probe.js";

// What this sandbox has: composed from the same fragment sources composeEnvironment uses, for attribution, plus the
// container's own answers. Three groups: what an agent asked for and the owner approved, what a capability costs, and
// what every sandbox ships with — the last is what a delta-only overlay view would otherwise miss.

// Named by hand; the image explains why each is baked, not what it does; only shown when the command answers, which is
// also what keeps a pack's tools (uv, ruff, pyright) off a sandbox whose image does not bake that pack. `locate` is for
// a tool that is installed but not on PATH: it names the binary to ask instead.
interface Staple {
    readonly bin: string;
    readonly name: string;
    readonly purpose: string;
    readonly locate?: (logger: Services["logger"]) => Promise<string | undefined>;
}

// Playwright installs its browser under its own cache, never on PATH, so `chromium` answered nothing and the browser
// every agent drives was missing from the list. Asked at the path the daemon's own playwright launches, which the
// browser pack installs to match.
const playwrightChromium = async (logger: Services["logger"]): Promise<string | undefined> => {
    try {
        const { chromium } = await import("playwright");
        const path = chromium.executablePath();
        return existsSync(path) ? path : undefined;
    } catch (error) {
        logger.warn({ err: error }, "environment: Playwright's Chromium path could not be read");
        return undefined;
    }
};

const STAPLES: readonly Staple[] = [
    { bin: "node", name: "Node.js", purpose: "The runtime everything JavaScript in here runs on." },
    { bin: "pnpm", name: "pnpm", purpose: "Installs and runs workspace packages." },
    { bin: "git", name: "Git", purpose: "Every repo in the workspace is a real git repo." },
    { bin: "gh", name: "GitHub CLI", purpose: "Pull requests, issues, releases and CI runs from the command line." },
    {
        bin: "python3",
        name: "Python",
        purpose: "Scripting, with YAML and image reading baked in; anything else via pip inside a virtual environment.",
    },
    { bin: "uv", name: "uv", purpose: "Installs Python projects and the interpreters they ask for." },
    { bin: "ruff", name: "Ruff", purpose: "Lints and formats Python, and checks every Python file an agent edits." },
    { bin: "pyright", name: "Pyright", purpose: "Type-checks Python where the project's environment resolves." },
    { bin: "rg", name: "ripgrep", purpose: "Fast text search across the workspace, and the engine behind code search." },
    { bin: "jq", name: "jq", purpose: "Reads and rewrites JSON on the command line." },
    { bin: "yq", name: "yq", purpose: "The same for YAML, compose files, pipelines, manifests." },
    { bin: "sqlite3", name: "SQLite", purpose: "Opens and queries a local database file." },
    { bin: "g++", name: "C++ build tools", purpose: "Compiles the native dependencies an install builds from source." },
    { bin: "make", name: "make", purpose: "Runs Makefile targets." },
    { bin: "curl", name: "curl", purpose: "Fetches over HTTP from the command line." },
    { bin: "ssh", name: "OpenSSH", purpose: "Reaches other machines, and lets them reach this sandbox." },
    { bin: "rsync", name: "rsync", purpose: "Copies file trees between machines." },
    { bin: "tmux", name: "tmux", purpose: "The sessions behind the terminals panel." },
    { bin: "cloudflared", name: "cloudflared", purpose: "Puts a local port on a public URL." },
    { bin: "docker", name: "Docker", purpose: "Builds and runs containers, dormant until the Docker capability grants it privileges." },
    { bin: "chromium", name: "Chromium", purpose: "The real browser the agent drives and screenshots.", locate: playwrightChromium },
    { bin: "ffmpeg", name: "FFmpeg", purpose: "Converts and encodes audio and video." },
];

// A block plus where it came from, before probing turns it into an item.
interface Candidate {
    readonly block: OverlayBlock;
    readonly origin: EnvironmentItem["origin"];
    readonly originLabel?: string;
    readonly state?: EnvironmentItem["state"];
    // Only an agent-asked block is the owner's to take out; a capability's goes with its capability.
    readonly removable?: Pick<EnvironmentItem, "block">;
}

// Every overlay fragment, attached to its contributor. Pack names are recovered by hashing the fragment's own content
// and looking it up, so a rename or a new provider does not lose the label.
const capabilityCandidates = async (services: Services): Promise<Candidate[]> => {
    const packs = new Map((await listPacks()).map((pack) => [pack.hash, pack.name]));
    const named = (content: string, fallback: string): OverlayBlock => ({ name: packs.get(sha256Hex(content.trim())) ?? fallback, body: content });
    const candidates: Candidate[] = [];
    for (const capability of await services.capabilities.list()) {
        for (const fragment of await services.environmentSources.capabilityFragments(capability)) {
            candidates.push({ block: named(fragment, capability.id), origin: "capability", originLabel: `${capability.id} capability` });
        }
    }
    for (const fragment of await services.environmentSources.workspaceExtensionFragments()) {
        candidates.push({ block: named(fragment, "extension"), origin: "capability", originLabel: "workspace extension" });
    }
    for (const fragment of await services.environmentSources.providerPackFragments()) {
        candidates.push({ block: named(fragment, "provider"), origin: "capability", originLabel: "a connected AI account" });
    }
    for (const fragment of await privacyPackFragments(services)) {
        candidates.push({ block: named(fragment, "privacy"), origin: "capability", originLabel: "the privacy shield" });
    }
    return candidates;
};

// Custom blocks plus what a proposal adds on top; a block that differs from its approved counterpart, or has none, is
// exactly what the owner is being asked to decide on. One row per tool: a revised block stands in for the one it
// replaces, and a repeat an older release appended is not listed twice.
const customCandidates = async (services: Services): Promise<Candidate[]> => {
    const approved = uniqueBlocks(splitBlocks(((await services.files.read(customPath(services))) ?? "").trim()));
    const proposed = uniqueBlocks(splitBlocks(((await services.files.read(proposalPath(services))) ?? "").trim()));
    const settled = new Set(approved.map((block) => `${block.name}\u0000${block.body}`));
    const incoming = proposed.filter((block) => !settled.has(`${block.name}\u0000${block.body}`));
    const replaced = new Set(incoming.map((block) => block.name));
    return [
        ...approved
            .filter((block) => !replaced.has(block.name))
            .map((block): Candidate => ({ block, origin: "custom", removable: { block: block.name } })),
        ...incoming.map((block): Candidate => ({ block, origin: "custom", state: "awaiting-approval", removable: { block: block.name } })),
    ];
};

// A block named after the exact command it installs keeps that spelling (`ffmpeg`, never "Ffmpeg"); anything else is a
// slug, title-cased into words. No lookup table: it would rot with every new block.
const displayName = (name: string, tools: readonly { readonly name: string }[]): string => {
    if (tools.some((tool) => tool.name === name)) {
        return name;
    }
    const words = name.replace(/[-_]+/g, " ").trim();
    return words === "" ? "Custom step" : words.charAt(0).toUpperCase() + words.slice(1);
};

type Tool = EnvironmentItem["tools"][number];

// A probed command as the view carries it: present with a version, present without one, or not here at all.
const toolOf = (name: string, probe: { version: string | undefined; found: boolean } | undefined): Tool | undefined => {
    if (probe?.found !== true) {
        return undefined;
    }
    return probe.version === undefined ? { name } : { name, version: probe.version };
};

export const readEnvironmentContents = async (services: Services): Promise<EnvironmentContents> => {
    const candidates = [...(await customCandidates(services)), ...(await capabilityCandidates(services))];
    const tooling = candidates.map((candidate) => blockTools(candidate.block));
    // What each staple is asked as: its own name on PATH, or the binary its `locate` found.
    const asked = new Map(
        await Promise.all(STAPLES.map(async (staple) => [staple.bin, (await staple.locate?.(services.logger)) ?? staple.bin] as const)),
    );
    // One probe per distinct command across the whole view, staples included; prefix modules read their manifest.
    const [probes, moduleProbes, packageProbes] = await Promise.all([
        probeAll([...tooling.flatMap((tools) => tools.candidates), ...asked.values()]),
        probeModules(tooling.flatMap((tools) => tools.modules.map((module) => ({ name: module.name, manifest: module.manifest })))),
        probePackages(tooling.flatMap((tools) => tools.packages)),
    ]);

    // Fallback state for a block with nothing probeable to check (a runtime directive, ENV-only fragment).
    const built = services.config.sandbox.environmentHash !== "";

    const items: EnvironmentItem[] = [];
    for (const [index, candidate] of candidates.entries()) {
        const { candidates: bins, packages, modules } = tooling[index] ?? { candidates: [], packages: [], modules: [] };
        const answered = [
            ...bins.map((bin) => toolOf(bin, probes.get(bin))),
            ...modules.map((module) => toolOf(module.name, moduleProbes.get(module.name))),
        ].filter((tool) => tool !== undefined);
        // A package named for no command it ships (imagemagick, sysstat) answers through dpkg only when no command did.
        const tools =
            answered.length > 0 ? answered : packages.map((name) => toolOf(name, packageProbes.get(name))).filter((tool) => tool !== undefined);
        const plumbing = packages.filter((name) => !tools.some((tool) => tool.name === name)).length;
        const prose = blockProse(candidate.block.body, candidate.originLabel);
        const purpose = purposeOf(prose);
        const detail = detailOf(prose, purpose);
        const commands = blockCommands(candidate.block.body);
        // Observed beats inferred: a block whose commands answer is active regardless of hashes.
        const pending = bins.length > 0 || modules.length > 0;
        const state = candidate.state ?? (tools.length > 0 ? "active" : pending ? "after-rebuild" : built ? "active" : "after-rebuild");
        items.push({
            id: `${candidate.origin}:${candidate.block.name}`,
            name: displayName(candidate.block.name, tools),
            origin: candidate.origin,
            ...(candidate.originLabel !== undefined ? { originLabel: candidate.originLabel } : {}),
            state,
            tools,
            ...(plumbing > 0 ? { extras: plumbing } : {}),
            ...(purpose !== undefined ? { purpose } : {}),
            ...(detail !== undefined ? { detail } : {}),
            ...(commands !== "" ? { commands } : {}),
            ...candidate.removable,
        });
    }

    // A staple the recipe already claims is not listed twice; the overlay's own entry wins.
    const claimed = new Set(items.flatMap((item) => item.tools.map((tool) => tool.name)));
    for (const staple of STAPLES) {
        const tool = claimed.has(staple.bin) ? undefined : toolOf(staple.bin, probes.get(asked.get(staple.bin) ?? staple.bin));
        if (tool === undefined) {
            continue;
        }
        items.push({ id: `base:${staple.bin}`, name: staple.name, origin: "base", state: "active", tools: [tool], purpose: staple.purpose });
    }

    return { items };
};
