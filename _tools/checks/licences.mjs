#!/usr/bin/env node
// What intentic hands to other people must be licensed so it may be handed on: the production closure of every unit that
// leaves the repository, read from the installed package.json files, refuses copyleft and non-redistributable terms and
// holds weak copyleft for review. REVIEWED is what the owner accepted, each with the licence it was read at and why.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { publishSet } from "../scripts/lib/packages.mjs";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";
import { readWorkspaceGraph } from "./lib/workspace-graph.mjs";

// Keyed by package name, where `*` spans a platform suffix (each machine installs only its own binary); `licence` is the
// text it was read at, undefined for a package that declares none, so a package that changes its terms is read again.
const REVIEWED = new Map([
    [
        "libsignal",
        {
            licence: "GPL-3.0",
            why: "Needs an owner decision: baileys, the WhatsApp extension's protocol client, depends on it, and prepare-image-trees.sh copies extensions/whatsapp into the sandbox image, which hands a GPL-3.0 library to everyone who pulls the image.",
        },
    ],
    [
        "@anthropic-ai/claude-agent-sdk",
        {
            licence: "SEE LICENSE IN README.md",
            why: "Needs an owner decision: the daemon's Claude runtime, whose README points at Anthropic's Commercial Terms of Service rather than an open licence, and which the image keeps where it prunes @cursor/sdk (prepare-image-trees.sh).",
        },
    ],
    [
        "@anthropic-ai/claude-agent-sdk-*",
        {
            licence: "SEE LICENSE IN LICENSE.md",
            why: 'Needs an owner decision: the Claude Code binary the SDK runs, one package per platform, "All rights reserved" under Anthropic\'s legal agreements, shipped in the sandbox image with the SDK.',
        },
    ],
    [
        "@img/sharp-*",
        {
            licence: "LGPL-3.0-or-later",
            why: "Needs an owner decision: the prebuilt libvips sharp loads (the daemon's dependency, and @huggingface/transformers' for iq), dynamically linked; the image hands it on, and LGPL asks for its notice and a way to replace the library.",
        },
    ],
    [
        "web-push",
        {
            licence: "MPL-2.0",
            why: "Needs an owner decision: the daemon's push-notification sender, shipped unmodified in the sandbox image; MPL-2.0 is file-level copyleft and asks for the source of those files, which npm already publishes.",
        },
    ],
    [
        "buffers",
        {
            licence: undefined,
            why: "Needs an owner decision: substack's package declares no licence and carries no licence file; fileq reaches it through exceljs > unzipper > binary, and the sandbox image ships it.",
        },
    ],
    [
        "khroma",
        {
            licence: undefined,
            why: "Needs an owner decision: mermaid's colour library names no licence in its manifest, and the license file beside it is MIT; the desktop app ships @intentic/ui, which depends on mermaid.",
        },
    ],
    [
        "@dicebear/styles",
        {
            licence: undefined,
            why: 'Needs an owner decision: no licence field; its LICENSE licenses each avatar style separately, several CC BY 4.0 (attribution) and some "free for personal and commercial use"; the desktop app ships @intentic/ui, which depends on it.',
        },
    ],
]);

/* ---- what leaves the repository, read from where each artifact is built ------------------------------------ */

const graph = readWorkspaceGraph(root);
const memberAt = new Map([...graph.packages.values()].map((member) => [member.dir, member]));
const units = new Map();
const ship = (member, where) => {
    if (member === undefined) {
        cannotMeasure(
            `licences: a list of what ships names a package that is not a workspace member (${where}); the list moved and this check needs updating`,
        );
    }
    const unit = units.get(member.name) ?? units.set(member.name, { member, where: new Set(), prunes: [] }).get(member.name);
    unit.where.add(where);
    return unit;
};
const read = (path) => readFileSync(join(root, path), "utf8");
// The words of one shell list, `\` continuations and quoted expansions (`"${PUB[@]}"`) dropped.
const listed = (text, pattern, what) =>
    (pattern.exec(text)?.[1] ?? cannotMeasure(`licences: could not read ${what}; its shape changed and this check needs updating`))
        .split(/\s+/)
        .filter((word) => word !== "" && word !== "\\" && !word.startsWith('"$'));

for (const dir of publishSet() ?? cannotMeasure("licences: could not read PUB out of _tools/scripts/lib/packages.sh")) {
    ship(memberAt.get(dir), "on npm");
}

// The image's trees are pruned by hand after `pnpm deploy`, and a pruned package is not handed on with the image.
const image = read("_tools/scripts/image/prepare-image-trees.sh");
const trees = new Map();
for (const [name, out] of listed(image, /^TREES="([^"]*)"/m, "TREES in prepare-image-trees.sh").map((entry) => entry.split(":"))) {
    trees.set(out.replace(/^\$out\//, ""), ship(graph.packages.get(name), "in the sandbox image"));
}
for (const ext of listed(image, /^BUNDLES="([^"]*)"/m, "BUNDLES in prepare-image-trees.sh")) {
    ship(memberAt.get(`_extensions/${ext}`), "in the sandbox image");
}
const storeGlob = (store) => {
    const name = store.replace(/@\*$/, "").replaceAll("+", "/");
    return new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
};
for (const [, tree, store] of image.matchAll(/rm -rf "\$out"\/([^/\s]+)\/node_modules\/\.pnpm\/(\S+)/g)) {
    trees.get(tree)?.prunes.push(storeGlob(store));
}

// A desktop build bundles the member its Tauri config sits in; a GitHub Action bundles the member its action.yml sits in.
for (const member of graph.packages.values()) {
    if (existsSync(join(root, member.dir, "src-tauri/tauri.conf.json"))) {
        ship(member, "in the desktop app");
    }
    if (existsSync(join(root, member.dir, "action.yml"))) {
        ship(member, "in the GitHub Action");
    }
}
// VERSIONED beyond PUB: the private packages that put the release version into an artifact of their own. The image's is
// already read from its script above, so this adds the ones nothing else names (the browser extension's zip).
for (const dir of listed(read("_tools/scripts/lib/packages.sh"), /^VERSIONED=\(([\s\S]*?)\)/m, "VERSIONED in packages.sh")) {
    const member = memberAt.get(dir);
    if (!units.has(member?.name)) {
        ship(member, "as a release artifact");
    }
}

if (!existsSync(join(root, "node_modules"))) {
    finish(
        [],
        [
            `licences: ${units.size} shipped units not read (their licences live in node_modules, and this ran before the install); the verify jobs read them`,
        ],
    );
    process.exit(0);
}

/* ---- the production closure, walked through what is installed ----------------------------------------------- */

// `"parent>child": "-"` among pnpm-workspace.yaml's overrides removes that edge from the install on purpose.
const removed = new Set();
let inOverrides = false;
for (const line of read("pnpm-workspace.yaml").split("\n")) {
    inOverrides = /^\S/.test(line) ? line.startsWith("overrides:") : inOverrides;
    const edge = inOverrides ? /^\s+"?([^"\s]+?)>([^"\s]+?)"?\s*:\s*["']-["']/.exec(line) : null;
    if (edge !== null) {
        removed.add(`${edge[1].replace(/(.)@.*$/, "$1")}>${edge[2]}`);
    }
}

// Node's own lookup, bounded by the install the package sits in: every ancestor's node_modules, never one named that.
const installRoot = (dir) => {
    const at = dir.indexOf(`${sep}node_modules${sep}`);
    return at === -1 ? root : dir.slice(0, at);
};
const found = new Map();
const locate = (from, name) => {
    const key = `${from}\0${name}`;
    if (!found.has(key)) {
        let at;
        for (let dir = from, bound = installRoot(from); at === undefined; dir = dirname(dir)) {
            const candidate = join(dir, "node_modules", name);
            at = basename(dir) !== "node_modules" && existsSync(join(candidate, "package.json")) ? realpathSync(candidate) : undefined;
            if (dir === bound || dirname(dir) === dir) {
                break;
            }
        }
        found.set(key, at);
    }
    return found.get(key);
};

// What a package asks to have installed beside it: its dependencies, optional ones, and every peer it does not mark
// optional (a pnpm install links those in). `optional` says whether an absence is expected rather than a gap.
const manifests = new Map();
const manifestAt = (dir) => {
    if (!manifests.has(dir)) {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        const optionalPeers = new Set(
            Object.keys(pkg.peerDependenciesMeta ?? {}).filter((name) => pkg.peerDependenciesMeta[name]?.optional === true),
        );
        const wants = [
            ...Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, optional: false })),
            ...Object.keys(pkg.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
            ...Object.keys(pkg.peerDependencies ?? {})
                .filter((name) => !optionalPeers.has(name))
                .map((name) => ({ name, optional: false })),
        ];
        manifests.set(dir, { pkg, wants });
    }
    return manifests.get(dir);
};

const shipped = new Map(); // installed dir -> { pkg, where: Set, chain }
const notInstalled = new Set();
const walkUnit = (unit) => {
    // npm ships a package whole, so a prune in the image script spares nothing for one published there too.
    const spared = (name) => !unit.where.has("on npm") && unit.prunes.some((prune) => prune.test(name));
    const seen = new Set();
    const queue = [{ dir: join(root, unit.member.dir), chain: [unit.member.name], member: true }];
    while (queue.length > 0) {
        const { dir, chain, member } = queue.shift();
        if (seen.has(dir)) {
            continue;
        }
        seen.add(dir);
        const { pkg, wants } = manifestAt(dir);
        if (!member) {
            const record = shipped.get(dir) ?? shipped.set(dir, { pkg, where: new Set(), chain }).get(dir);
            unit.where.forEach((where) => record.where.add(where));
        }
        for (const want of wants.filter(({ name }) => !spared(name) && !removed.has(`${pkg.name}>${name}`))) {
            queue.push(...next({ dir, pkg, chain, member }, want));
        }
    }
};
// A member hands on its dependencies and optional ones, never its peers: whoever installs it provides those.
const handsOn = (pkg, name) => Object.hasOwn(pkg.dependencies ?? {}, name) || Object.hasOwn(pkg.optionalDependencies ?? {}, name);
const next = ({ dir, pkg, chain, member }, { name, optional }) => {
    if (member && !handsOn(pkg, name)) {
        return [];
    }
    const workspace = member ? graph.packages.get(name) : undefined;
    if (workspace !== undefined) {
        return [{ dir: join(root, workspace.dir), chain: [...chain, name], member: true }];
    }
    const at = locate(dir, name);
    if (at === undefined && !optional) {
        notInstalled.add(`${pkg.name} > ${name}`);
    }
    return at === undefined ? [] : [{ dir: at, chain: [...chain, name], member: false }];
};
for (const unit of units.values()) {
    walkUnit(unit);
}

/* ---- the verdict on each licence ------------------------------------------------------------------------------ */

// SPDX ids (and the older spellings still published) that let a copy be handed on with nothing owed but the notice.
const PERMISSIVE = new Set([
    "0bsd",
    "apache-2.0",
    "artistic-2.0",
    "blueoak-1.0.0",
    "bsd",
    "bsd-2-clause",
    "bsd-3-clause",
    "bsl-1.0",
    "cc-by-3.0",
    "cc-by-4.0",
    "cc0-1.0",
    "isc",
    "mit",
    "mit-0",
    "ofl-1.1",
    "psf-2.0",
    "python-2.0",
    "unicode-3.0",
    "unicode-dfs-2016",
    "unlicense",
    "wtfpl",
    "x11",
    "zlib",
]);
// Copyleft that reaches the work shipped beside it, and terms that forbid handing a copy on at all. `gpl` is anchored,
// so LGPL is not refused here: it is weak copyleft, which like anything unlisted asks for a review.
const REFUSED = /^(agpl|gpl|sspl|busl|elastic|polyform|cc-by-nc|fsl)/;
// A licence statement rather than a licence: nothing in it says what may be done with the package.
const UNSTATED = /^(unlicensed|see licen[cs]e in|unknown|none|n\/a)/i;
const RANK = { permissive: 0, review: 1, refused: 2 };

const licenceOf = (declared) => {
    if (Array.isArray(declared)) {
        return (
            declared
                .map(licenceOf)
                .filter((licence) => licence !== undefined)
                .join(" OR ") || undefined
        );
    }
    return (typeof declared === "string" ? declared : declared?.type)?.trim() || undefined;
};
const termVerdict = (term) => {
    const id = term.toLowerCase().replace(/\+$/, "");
    const verdict = PERMISSIVE.has(id) ? "permissive" : REFUSED.test(id) ? "refused" : "review";
    return { verdict, terms: verdict === "permissive" ? [] : [term] };
};
const worse = (a, b) => (RANK[b.verdict] > RANK[a.verdict] ? b : a);

// SPDX precedence, AND binding tighter than OR; `/` is the older spelling of OR, and an id written with spaces ("CC0 1.0")
// is read as one. The verdict carries the terms that decided it, which is what a REVIEWED entry answers for.
const OPERATORS = new Set(["(", ")", "and", "or", "with"]);
const evaluate = (expression) => {
    const tokens = expression.replaceAll("/", " OR ").match(/\(|\)|[^\s()]+/g) ?? [];
    let at = 0;
    const is = (word) => tokens[at]?.toLowerCase() === word;
    // `X WITH exception` is X's verdict, except that the Commons Clause takes away the right to sell what X granted.
    const term = () => {
        const words = [];
        while (at < tokens.length && !OPERATORS.has(tokens[at].toLowerCase())) {
            words.push(tokens[at]);
            at += 1;
        }
        const exception = is("with") ? (tokens[at + 1] ?? "") : "";
        at += exception === "" ? 0 : 2;
        return /commons-clause/i.test(exception)
            ? { verdict: "refused", terms: [`${words.join("-")} WITH ${exception}`] }
            : termVerdict(words.join("-"));
    };
    const primary = () => {
        if (!is("(")) {
            return term();
        }
        at += 1;
        const inner = either();
        at += 1;
        return inner;
    };
    const both = () => {
        let result = primary();
        while (is("and")) {
            at += 1;
            const right = primary();
            result = { verdict: worse(result, right).verdict, terms: [...result.terms, ...right.terms] };
        }
        return result;
    };
    const either = () => {
        let result = both();
        while (is("or")) {
            at += 1;
            const right = both();
            result = RANK[right.verdict] < RANK[result.verdict] ? right : result;
        }
        return result;
    };
    return either();
};
const judge = (licence) => (licence === undefined || UNSTATED.test(licence) ? { verdict: "unstated", terms: [licence] } : evaluate(licence));

const globOf = (key) =>
    new RegExp(
        `^${key
            .split("*")
            .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
    );
const reviews = [...REVIEWED].map(([key, review]) => ({ key, test: globOf(key), ...review }));
const used = new Set();
const reviewed = (name, terms) => {
    const review = reviews.find((entry) => entry.test.test(name) && terms.every((term) => term === entry.licence));
    if (review !== undefined) {
        used.add(review.key);
    }
    return review !== undefined;
};

const SAYS = {
    refused: (licence) => `is ${licence}, which intentic may not hand on under its own licence`,
    review: (licence) => `is ${licence}, which needs a review before intentic hands it on`,
    unstated: (licence) => (licence === undefined ? "declares no licence" : `declares "${licence}" rather than a licence`),
};
const findings = [];
let thirdParty = 0;
for (const { pkg, where, chain } of shipped.values()) {
    if (graph.packages.has(pkg.name)) {
        continue;
    }
    thirdParty += 1;
    const licence = licenceOf(pkg.license ?? pkg.licenses);
    const { verdict, terms } = judge(licence);
    if (verdict === "permissive" || reviewed(pkg.name, terms)) {
        continue;
    }
    const readAt = reviews.find((entry) => entry.test.test(pkg.name));
    const was = readAt === undefined ? "" : ` (REVIEWED read it at ${readAt.licence ?? "no licence"})`;
    findings.push(`${pkg.name}@${pkg.version} ${SAYS[verdict](licence)}${was}: ${chain.join(" > ")}, shipped ${[...where].join(", ")}`);
}

// An install missing packages read less than the tree ships, so an entry it saw nothing of is not evidence of a cut.
for (const { key } of notInstalled.size === 0 ? reviews.filter((entry) => !used.has(entry.key)) : []) {
    console.log(
        `licences: REVIEWED names ${key}, which nothing shipped carries at the licence it was read at: drop it when you next edit _tools/checks/licences.mjs`,
    );
}
const gaps =
    notInstalled.size === 0
        ? ""
        : `; ${notInstalled.size} declared dependencies are not installed here, so not read (${[...notInstalled].slice(0, 3).join(", ")}${notInstalled.size > 3 ? ", …" : ""})`;
finish(
    [
        [
            "A package intentic ships under terms that forbid handing it on, or that nobody has reviewed: replace it, stop shipping it, or record the decision in REVIEWED (_tools/checks/licences.mjs) with the licence it was read at and why",
            findings.sort(),
        ],
    ],
    [
        `licences: ${units.size} shipped units carry ${thirdParty} third-party packages, each under a licence that lets it be handed on or reviewed by the owner (${used.size} reviewed)${gaps}`,
    ],
);
