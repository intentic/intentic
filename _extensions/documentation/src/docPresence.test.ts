import { STATE_DIR } from "@intentic/sandbox-contract";
// Pins that the presence poll never asks about an undocumented repo; it reads a fact the daemon already computes
// instead.
import { beforeEach, expect, test, vi } from "vitest";
import { bindHost } from "./host.js";
import { documentAt, refreshDocumentPresence } from "./docPresence.js";

const INDEX = JSON.stringify({
    repo: `web`,
    entries: [{ dir: `src/pricing`, oneLiner: `What a plan costs, and why.` }],
});

// The reads this poll makes, in order; the subject of the assertions, not a side effect.
let asked: string[];

// Two repos: `web` has documentation, `api` doesn't; its staged draft is still walked, with no fact to gate on.
const hostOver = (): Parameters<typeof bindHost>[0] =>
    ({
        sandbox: {
            reachable: () => true,
            json: async (route: string) => {
                asked.push(route);
                return route.includes(encodeURIComponent(`${STATE_DIR}/config/docs/api`))
                    ? { entries: [{ name: `repo.json`, path: `${STATE_DIR}/config/docs/api/repo.json`, type: `file` }], hidden: 0 }
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
    // Waits for the map's own entry, not just any value, since the presence store fills in stages.
    await vi.waitFor(() => expect(documentAt(`web`)).toEqual({ oneLiner: ``, draft: false }));
    expect(asked.filter((route) => route.startsWith(`web/`))).toEqual([`web/docs/architecture/index.json`, `web/docs/architecture/repo.json`]);
    // Its staged tree is still listed, even though nothing else about it is read.
    expect(asked.filter((route) => route.startsWith(`api/`))).toEqual([]);
    expect(asked.some((route) => route.includes(encodeURIComponent(`.intentic/config/docs/api`)))).toBe(true);
});

test(`the documented repo's packages and map land on the tree, and the undocumented one's draft still does`, async () => {
    // Waits for the map's own entry, not just any value, since the presence store fills in stages.
    await vi.waitFor(() => expect(documentAt(`web`)).toEqual({ oneLiner: ``, draft: false }));
    expect(documentAt(`web/src/pricing`)).toEqual({ oneLiner: `What a plan costs, and why.`, draft: false });
    expect(documentAt(`web`)).toEqual({ oneLiner: ``, draft: false });
    // Nothing published, only a staged draft, so the row reads as draft.
    expect(documentAt(`api`)).toEqual({ oneLiner: ``, draft: true });
});
