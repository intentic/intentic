import { STATE_DIR } from "@intentic/constants";
import { describe, expect, test } from "vitest";
import { auditBrief, extensionBrief, publishBrief, tightenBrief, updateBrief } from "./extensionBrief";

// What the brief must not lose: four facts an agent can't recover on its own, each once the cause of a directory
// that stopped loading.

const brief = extensionBrief({
    id: `workspace.release-notes`,
    dir: `${STATE_DIR}/config/workspace-extensions/release-notes`,
    wish: `  a list of what shipped this week, from the git log  `,
});

describe(`the brief handed to an authoring agent`, () => {
    test(`carries the author's own words, not a paraphrase of them`, () => {
        // Verbatim and trimmed, so the person and the agent argue over one exact statement of the goal.
        expect(brief).toContain(`"a list of what shipped this week, from the git log"`);
    });

    test(`names the two files by path, so nothing has to be searched for`, () => {
        expect(brief).toContain(`.intentic/config/workspace-extensions/release-notes/extension.js`);
        expect(brief).toContain(`.intentic/config/workspace-extensions/release-notes/intentic-extension.json`);
    });

    test(`states every constraint that is invisible from inside the directory`, () => {
        // Four Vue-not-host mistakes checked for: bundling, an SFC, an undeclared registration, stray daemon routes.
        expect(brief).toContain(`ONE file`);
        expect(brief).toContain(`h()`);
        expect(brief).toContain(`Declare every contribution`);
        expect(brief).toContain(`permissions.sandbox`);
    });

    test(`ends on something the agent can check rather than claim`, () => {
        // Readable off the Extensions tab, which names any directory that stopped parsing.
        expect(brief).toContain(`Not loadable`);
        expect(brief).toContain(`workspace.release-notes`);
    });
});

describe(`the brief for tightening permissions`, () => {
    const tighten = tightenBrief({
        id: `workspace.release-notes`,
        dir: `${STATE_DIR}/config/workspace-extensions/release-notes`,
        unused: [`POST /agent`, `GET /panels`],
        used: [{ route: `GET /workspace/file`, calls: 1240 }],
    });

    test(`shows both sides of the evidence, so the claim can be weighed`, () => {
        // Without used counts, an exercised extension and an unopened one produce the same list of zeroes.
        expect(tighten).toContain(`POST /agent, GET /panels`);
        expect(tighten).toContain(`GET /workspace/file (1,240)`);
    });

    test(`asks for a decision per route, not for the marked ones to be deleted`, () => {
        // Guards against an agent treating the panel's marks as a checklist and stripping a route an error path needs.
        expect(tighten).toContain(`Remove a route only when nothing in the code can reach it`);
        expect(tighten).toContain(`one-line reason`);
    });

    test(`forbids the turn from widening into the code`, () => {
        expect(tighten).toContain(`edits \`permissions.sandbox\` and nothing else`);
    });
});

describe(`the brief for publishing`, () => {
    const publish = publishBrief({
        id: `workspace.release-notes`,
        dir: `${STATE_DIR}/config/workspace-extensions/release-notes`,
        name: `release-notes`,
    });

    test(`forbids any change between the check and the push`, () => {
        expect(publish).toContain(`no tidy-up, no reformat, no version bump`);
    });

    test(`routes discovery through the scan, not a hand-written listing`, () => {
        // The topic is what the nightly scan discovers repositories by; a hand-opened PR duplicates that review.
        expect(publish).toContain(`intentic-extension`);
        expect(publish).toContain(`Do not open a listing pull request yourself unless asked`);
    });

    test(`ends on the sha, because the sha is the identity`, () => {
        expect(publish).toContain(`reported the pushed commit sha`);
    });
});

describe(`the brief for reading before installing`, () => {
    const audit = auditBrief({ label: `acme.incidents`, url: `https://github.com/acme/incidents.git`, ref: `a`.repeat(40), path: `` });

    test(`pins the audit to the exact commit the install would pin`, () => {
        // The branch may have moved since the listing; the exact commit is what would actually be installed.
        expect(audit).toContain(`a`.repeat(40));
        expect(audit).toContain(`the branch may have moved`);
    });

    test(`is read-only, and says so as a rule rather than a tendency`, () => {
        expect(audit).toContain(`reads and reports; it changes nothing`);
        expect(audit).toContain(`Do not install it`);
    });

    test(`walks the permissions, which are the part worth a stranger's scrutiny`, () => {
        // The manifest names reach; only the code says what actually uses it.
        expect(audit).toContain(`permission by permission`);
        expect(audit).toContain(`quoting file and line`);
    });

    test(`does not mistake the manifest for browser confinement`, () => {
        expect(audit).toContain(`shares the app's DOM, storage and network access`);
        expect(audit).toContain(`not confinement`);
        expect(audit).toContain(`server and process entry`);
        expect(audit).toContain(`plugin/MCP`);
        expect(audit).toContain(`account for executed artifacts from readable source`);
        expect(audit).toContain(`install dependencies`);
    });

    test(`ends on a recommendation, not a summary`, () => {
        expect(audit).toContain(`install it, install it and keep an eye on something named, or do not`);
    });
});

describe(`the brief for reading an update`, () => {
    const update = updateBrief({
        label: `acme.incidents`,
        url: `https://github.com/acme/incidents.git`,
        fromRef: `a`.repeat(40),
        toRef: `b`.repeat(40),
        path: ``,
    });

    test(`reads the diff, not the tree: the installed commit was already approved`, () => {
        expect(update).toContain(`read the diff between the two commits`);
        expect(update).toContain(`what is between them is the whole subject`);
    });

    test(`leads with the manifest delta, because new reach arrives dressed as an update`, () => {
        expect(update).toContain(`reach the owner never approved`);
    });

    test(`staying put is a first-class outcome`, () => {
        // An update review that can only ever say yes is a ritual, not a review.
        expect(update).toContain(`or stay on ${`a`.repeat(40).slice(0, 7)}`);
    });
});
