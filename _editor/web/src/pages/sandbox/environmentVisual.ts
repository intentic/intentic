import type { EnvironmentItem } from "@intentic-app/api-contract";
import type { IconName } from "@intentic/ui";

/* THE MARK ON A CONTENTS ROW — what makes "Rust, ffmpeg, Docker" legible from the left edge alone, instead of
 * eighteen identical boxes down a column that costs width and carries nothing.
 *
 * DERIVED IN THE BROWSER RATHER THAN SENT OVER THE WIRE. The wire carries what the sandbox HAS; which picture
 * this app draws for it is a fact about this app. Keeping the table here also means the marks appear against a
 * daemon that predates them — routinely the case, since the app plane serves whatever image was last pulled —
 * where a new wire field would arrive empty until the sandbox itself updates.
 *
 * MATCHED ON WORDS, not on whole names, because a block is named by whoever wrote it: `rust-tauri`, `Rust tauri`
 * and `rustc` all have to reach the same mark. The item's own name is asked first and the commands it installs
 * second — a block named after a product ("Discord") should keep the product's mark rather than take the one
 * belonging to the first tool inside it ("whisper-cli").
 *
 * TWO TIERS, BECAUSE THE FIRST HAS HOLES. Most of what a sandbox installs is somebody's product and has a brand
 * in the icon set; ripgrep, jq, yq, ssh and rsync have none, and handing those the same generic box would leave
 * a quarter of the list exactly as unscannable as before. So the second tier is a glyph chosen per KIND — a
 * magnifier for the searcher, a key for ssh, a wrench for the build runners — and only what neither tier
 * recognises falls through to the box.
 */

export interface EnvironmentVisual {
    /** A simple-icons slug for <BrandMark>, absent for anything with no brand in that set. */
    readonly logo?: string;
    /** What is painted under the brand: while it loads, if it fails, and forever when there is no slug. */
    readonly icon: IconName;
}

/* The brands, keyed by every word that should reach them. Slugs are verified against the CDN rather than
 * guessed — a 404 costs a request and degrades to the glyph, which is survivable but is a hole in a list whose
 * whole job is being scannable.
 *
 * GNU MAKE IS DELIBERATELY ABSENT. There IS a `make` slug and it is Make.com's purple M, so honouring it would
 * put a no-code automation brand beside a Makefile. A wrong logo is worse than no logo: the fallback glyph reads
 * as "no mark for this", while the wrong mark reads as a fact.
 */
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
    // Chromium's own mark is not in the set and Chrome's is the same shape in fuller colour — near enough to be
    // recognised as "the browser", which is the whole job here.
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

// The kinds with no brand to borrow, each given a glyph that says what it DOES — so the five brandless rows are
// still told apart at a glance, which a shared box never managed.
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
    // Painted under the browser's brand while it loads, and left there if the CDN is unreachable.
    chromium: `globe`,
    chrome: `globe`,
};

/* The words a name or a command offers up: `rust-tauri` → rust, tauri · `Node.js` → node, js · `C++ build tools`
 * → c++, build, tools. Punctuation that is part of the name survives (`c++`, `g++`, `whisper-cli` is asked whole
 * before it is split); only the separators go. */
const wordsOf = (text: string): string[] =>
    text
        .toLowerCase()
        .split(/[\s._/-]+/u)
        .filter((word) => word !== ``);

// Name before commands, whole before split — most specific first, so the least specific word never wins a match
// the block's own name could have answered.
const keysOf = (item: EnvironmentItem): string[] => [
    item.name.toLowerCase(),
    ...wordsOf(item.name),
    ...item.tools.flatMap((tool) => [tool.name.toLowerCase(), ...wordsOf(tool.name)]),
];

export const environmentVisual = (item: EnvironmentItem): EnvironmentVisual => {
    // A glyph found early is remembered but does not stop the search: a brand further down the list still wins
    // the top tier, and the glyph it passed becomes what sits under it.
    let icon: IconName | undefined;
    for (const key of keysOf(item)) {
        icon ??= ICONS[key];
        const logo = LOGOS[key];
        if (logo !== undefined) {
            return { logo, icon: icon ?? `box` };
        }
    }
    return { icon: icon ?? `box` };
};
