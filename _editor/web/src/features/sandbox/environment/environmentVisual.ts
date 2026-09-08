import type { EnvironmentItem } from "@intentic/api-contract";
import type { IconName } from "@intentic/ui";

// Marks derived in the browser, not sent over the wire, so they work against a daemon that predates them. Matched per
// word (not whole name), name checked before commands, so a block named after a product keeps its own brand. Two tiers:
// a brand logo, then a glyph by kind for tools with no brand.

export interface EnvironmentVisual {
    /** A simple-icons slug for <BrandMark>; absent for anything with no brand in that set. */
    readonly logo?: string;
    /** What's painted under the brand while it loads, if it fails, or forever when there's no slug. */
    readonly icon: IconName;
}

// Verified against the CDN, not guessed: a wrong logo reads as fact, so a slug that doesn't exist is not risked here.
// `make` is deliberately absent: the real `make` slug belongs to Make.com, not GNU Make.
const LOGOS: Readonly<Record<string, string>> = {
    ffmpeg: `ffmpeg`,
    bun: `bun`,
    rust: `rust`,
    rustc: `rust`,
    rustup: `rust`,
    cargo: `rust`,
    docker: `docker`,
    discord: `discord`,
    node: `nodedotjs`,
    nodejs: `nodedotjs`,
    npm: `npm`,
    pnpm: `pnpm`,
    yarn: `yarn`,
    deno: `deno`,
    git: `git`,
    gh: `github`,
    github: `github`,
    python: `python`,
    python3: `python`,
    pip: `python`,
    pip3: `python`,
    // The python pack's own tools carry no mark of their own, so they borrow the language's.
    uv: `python`,
    uvx: `python`,
    ruff: `python`,
    pyright: `python`,
    sqlite: `sqlite`,
    sqlite3: `sqlite`,
    "c++": `cplusplus`,
    "g++": `cplusplus`,
    gcc: `c`,
    cmake: `cmake`,
    curl: `curl`,
    bash: `gnubash`,
    tmux: `tmux`,
    cloudflare: `cloudflare`,
    cloudflared: `cloudflare`,
    // Chromium has no mark of its own; Chrome's is close enough to read as "the browser".
    chromium: `googlechrome`,
    chrome: `googlechrome`,
    pandoc: `pandoc`,
    go: `go`,
    golang: `go`,
    java: `openjdk`,
    javac: `openjdk`,
    jdk: `openjdk`,
    gradle: `gradle`,
    maven: `apachemaven`,
    mvn: `apachemaven`,
    kotlin: `kotlin`,
    swift: `swift`,
    android: `android`,
    php: `php`,
    ruby: `ruby`,
    gem: `ruby`,
    dotnet: `dotnet`,
    terraform: `terraform`,
    kubectl: `kubernetes`,
    kubernetes: `kubernetes`,
    helm: `helm`,
    ansible: `ansible`,
    postgres: `postgresql`,
    postgresql: `postgresql`,
    psql: `postgresql`,
    mysql: `mysql`,
    redis: `redis`,
    mongo: `mongodb`,
    mongodb: `mongodb`,
};

// A glyph per kind for tools with no brand to borrow, so brandless rows are still told apart at a glance.
const ICONS: Readonly<Record<string, IconName>> = {
    rg: `search`,
    ripgrep: `search`,
    grep: `search`,
    jq: `code`,
    yq: `code`,
    ssh: `key`,
    sshd: `key`,
    scp: `key`,
    openssh: `key`,
    rsync: `arrows-h`,
    make: `wrench`,
    gmake: `wrench`,
    ninja: `wrench`,
    whisper: `microphone`,
    "whisper-cli": `microphone`,
    convert: `image`,
    magick: `image`,
    imagemagick: `image`,
    graphviz: `sitemap`,
    // Shown under the browser's logo while it loads, and left in place if the CDN is unreachable.
    chromium: `globe`,
    chrome: `globe`,
};

// Splits into words on whitespace/punctuation separators; embedded punctuation like `c++`, `g++` survives since it
// isn't a separator.
const wordsOf = (text: string): string[] =>
    text
        .toLowerCase()
        .split(/[\s._/-]+/u)
        .filter((word) => word !== ``);

// Name before commands, whole name before its words: the most specific key is tried first, so a common word never wins
// a match the full name would have.
const keysOf = (item: EnvironmentItem): string[] => [
    item.name.toLowerCase(),
    ...wordsOf(item.name),
    ...item.tools.flatMap((tool) => [tool.name.toLowerCase(), ...wordsOf(tool.name)]),
];

// Continues past the first glyph match: a brand further down the key list still wins the logo tier, and the glyph
// already found becomes what's shown under it.
const visualFor = (keys: readonly string[]): EnvironmentVisual => {
    let icon: IconName | undefined;
    for (const key of keys) {
        icon ??= ICONS[key];
        const logo = LOGOS[key];
        if (logo !== undefined) {
            return { logo, icon: icon ?? `box` };
        }
    }
    return { icon: icon ?? `box` };
};

export const environmentVisual = (item: EnvironmentItem): EnvironmentVisual => visualFor(keysOf(item));

// The tool's own keys are tried before its ecosystem's; a package with a brand of its own keeps it, and only an
// unrecognised one borrows its package manager's logo.
export const runtimeInstallVisual = (tool: string, kind: string): EnvironmentVisual =>
    visualFor([tool.toLowerCase(), ...wordsOf(tool), kind.toLowerCase(), ...wordsOf(kind)]);
