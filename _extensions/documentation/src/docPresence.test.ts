// @vitest-environment jsdom
//
// WHAT THIS PROTECTS: the tree-icon poll must not ASK about a repo that documents nothing.
//
// It used to ask every repo for its index and its map on every tick — two reads per repo, forever, to learn what
// the daemon already reports as a fact (`RepoFacts.docs`, computed in the same pass as every other repo fact).
// Against a workspace of four undocumented repos that was eight failed reads on every page load and every minute
// after it, which is what filled the owner's console. The reads are gone; the fact decides.
import { beforeEach, expect, test, vi } from "vitest";
import { bindHost } from "./host.js";
import { documentAt, refreshDocumentPresence } from "./docPresence.js";

const INDEX = JSON.stringify({
    repo: `web`,
    entries: [{ dir: `src/pricing`, oneLiner: `What a plan costs, and why.` }],
});

// The reads this poll makes, in the order it makes them — the assertion subject, not a side effect.
let asked: string[];

/* A host over two repos: `web` carries documentation, `api` does not. `api` DOES have a staged draft, which is
 * the case that keeps this honest — the staged side has no fact to gate on (a run writes into it between polls),
 * so it is still walked for both repos and its answer still reaches the tree. */
const hostOver = (): Parameters<typeof bindHost>[0] =>
    ({
        sandbox: {
            reachable: () => true,
            json: async (route: string) => {
                asked.push(route);
                return route.includes(encodeURIComponent(`.intentic/docs/api`))
                    ? { entries: [{ name: `repo.json`, path: `.intentic/docs/api/repo.json`, type: `file` }], hidden: 0 }
                    : { entries: [], hidden: 0 };
            },
        },
        workspace: {
            repos: () => [
                { repo: `web`, docs: true },
                { repo: `api`, docs: false },
            ],
            file: async (path: string) => {
                asked.push(path);
                return path === `web/docs/architecture/index.json` ? INDEX : path === `web/docs/architecture/repo.json` ? `{}` : undefined;
            },
        },
    }) as unknown as Parameters<typeof bindHost>[0];

beforeEach(() => {
    asked = [];
    bindHost(hostOver());
    refreshDocumentPresence();
});

test(`reads the documented repo's index and map, and asks the undocumented one for neither`, async () => {
    await vi.waitFor(() => expect(documentAt(`web`)).toBeDefined());
    expect(asked.filter((route) => route.startsWith(`web/`))).toEqual([`web/docs/architecture/index.json`, `web/docs/architecture/repo.json`]);
    // The whole point: not one read against a repo that documents nothing. Its staged tree is still listed.
    expect(asked.filter((route) => route.startsWith(`api/`))).toEqual([]);
    expect(asked.some((route) => route.includes(encodeURIComponent(`.intentic/docs/api`)))).toBe(true);
});

test(`the documented repo's packages and map land on the tree, and the undocumented one's draft still does`, async () => {
    await vi.waitFor(() => expect(documentAt(`web`)).toBeDefined());
    expect(documentAt(`web/src/pricing`)).toEqual({ oneLiner: `What a plan costs, and why.`, draft: false });
    expect(documentAt(`web`)).toEqual({ oneLiner: ``, draft: false });
    // Nothing published, a draft staged — the row says draft, which is what the tab it opens will say too.
    expect(documentAt(`api`)).toEqual({ oneLiner: ``, draft: true });
});
