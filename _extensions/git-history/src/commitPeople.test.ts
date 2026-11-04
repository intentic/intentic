import { extensionIdOf } from "@intentic/extension-manifest";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import type { GitCommit } from "@intentic/sandbox-contract/schemas/git/git-history";
import { commitPeople, rowAuthor } from "./commitPeople.js";
import { messages } from "./i18n.js";
import { manifest } from "./manifest.js";

// The labels are asserted on, so the catalog is registered the way the host does.
await registerExtensionMessages(extensionIdOf(manifest), messages);

const commit = (over: Partial<GitCommit> = {}): GitCommit => ({
    sha: `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2`,
    short: `a1b2c3d`,
    parents: [],
    subject: `Fix the lane colours`,
    body: ``,
    author: `intentic`,
    email: `agent@intentic.dev`,
    at: 0,
    refs: [],
    head: false,
    ...over,
});

const ADA = { conversation: `c1`, name: `Ada Lovelace`, email: `ada@example.com` };

describe(`rowAuthor`, () => {
    it(`names who an agent's commit was for, not the agent`, () => {
        expect(rowAuthor(commit({ requestedBy: ADA }))).toBe(`for Ada Lovelace`);
        // No name kept for them: their address is what there is to call them.
        expect(rowAuthor(commit({ requestedBy: { conversation: `c1`, email: `ada@example.com` } }))).toBe(`for ada@example.com`);
    });

    // Settings that make the person the author already name them; one an automation opened answers to nobody.
    it(`keeps the author where it is a person, or where nobody answers for the work`, () => {
        expect(rowAuthor(commit({ author: `Ada Lovelace`, email: `ada@users.noreply.github.com`, requestedBy: ADA }))).toBe(`Ada Lovelace`);
        expect(rowAuthor(commit({ requestedBy: { conversation: `c1` } }))).toBe(`intentic`);
    });
});

describe(`commitPeople`, () => {
    it(`adds who the work was for under the author, with their address beside their name`, () => {
        expect(commitPeople(commit({ requestedBy: ADA }))).toEqual([
            { label: `Author`, name: `intentic`, email: `agent@intentic.dev` },
            { label: `Requested by`, name: `Ada Lovelace`, email: `ada@example.com` },
        ]);
        expect(commitPeople(commit({ requestedBy: { conversation: `c1`, email: `ada@example.com` } }))[1]).toEqual({
            label: `Requested by`,
            name: `ada@example.com`,
        });
        expect(commitPeople(commit())).toHaveLength(1);
    });
});
