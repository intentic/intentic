import { BINARY, type RepoSeed, type SeedAuthor, type SeedBody, type SeedCommit } from "./gitSeeds";
import { fileBody, fileDiff, REMOTE_REPOS } from "../workspace";

// The desk recording's histories (fixture/desk.ts): a maker's folders, each committed now and then as the work went
// along, with nothing branched or tagged. Built from the files the desk holds, so every path a commit names opens.

const TEXT = /\.(md|html|css|csv|svg|json|ts|txt)$/u;

// What a commit leaves a file as: its text where the desk carries one, else a stand-in a commit counts nothing for.
const bodyOf = (repo: string, path: string): SeedBody => {
    const changed = fileDiff(repo, path).before;
    if (changed !== undefined) {
        return changed;
    }
    return TEXT.test(path) ? (fileBody(`${repo}/${path}`) ?? BINARY) : BINARY;
};

const commit = (repo: string, id: string, subject: string, hoursAgo: number, paths: readonly string[], by: SeedAuthor = `owner`): SeedCommit => ({
    id,
    subject,
    by,
    hoursAgo,
    files: Object.fromEntries(paths.map((path) => [path, bodyOf(repo, path)])),
});

// One straight line of commits on `main`; a folder with a remote has pushed all of it.
const line = (repo: string, commits: readonly SeedCommit[]): RepoSeed => {
    const tip = commits.at(-1)?.id ?? ``;
    const pushed = REMOTE_REPOS.some((remote) => remote.repo === repo);
    const local: RepoSeed = { commits, head: `main`, branches: tip === `` ? {} : { main: tip } };
    return pushed ? { ...local, upstreams: { main: `origin/main` }, fetched: { main: tip }, server: { main: tip } } : local;
};

const DESK_SEEDS = new Map<string, RepoSeed>([
    [`root`, line(`root`, [commit(`root`, `d0`, `Start the studio's desk`, 1200, [`README.md`])])],
    [
        `newsletter`,
        line(`newsletter`, [
            commit(`newsletter`, `n1`, `Newsletter template`, 900, [`template.md`]),
            commit(`newsletter`, `n2`, `August issue`, 640, [`august.md`, `images/blue-jug.jpg`]),
            commit(`newsletter`, `n3`, `Subscribers from the market sign-up sheet`, 500, [`subscribers.csv`]),
            commit(`newsletter`, `n4`, `September issue`, 300, [`september.md`]),
            commit(`newsletter`, `n5`, `October issue, first draft`, 40, [`october.md`, `images/autumn-sale.jpg`], `agent`),
        ]),
    ],
    [
        `shop-site`,
        line(`shop-site`, [
            commit(`shop-site`, `s1`, `First version of the shop's site`, 1100, [`index.html`, `style.css`, `images/logo.svg`, `package.json`, `.gitignore`, `vite.config.ts`]),
            commit(`shop-site`, `s2`, `About page and opening hours`, 700, [`about.html`, `opening-hours.md`]),
            commit(`shop-site`, `s3`, `Photos of the storefront and the workshop`, 260, [`images/storefront.jpg`, `images/workshop.jpg`]),
        ]),
    ],
    [
        `letters`,
        line(`letters`, [
            commit(`letters`, `l1`, `Harbour market application`, 400, [`market-application.pdf`]),
            commit(`letters`, `l2`, `Notice to the landlord about the lease`, 120, [`landlord-notice.docx`]),
        ]),
    ],
    [
        `receipts`,
        line(`receipts`, [
            commit(`receipts`, `c1`, `August receipts`, 700, [`2026-08/hendriks-glazes.pdf`, `2026-08/rent.pdf`]),
            commit(`receipts`, `c2`, `September receipts`, 200, [`2026-09/hendriks-glazes.pdf`, `2026-09/clay-supplies.pdf`, `2026-09/harbour-market-stall.pdf`, `2026-09/rent.pdf`], `agent`),
        ]),
    ],
]);

/** The desk recording's history of one folder; undefined for one it does not hold. */
export const deskSeed = (repo: string): RepoSeed | undefined => DESK_SEEDS.get(repo);
