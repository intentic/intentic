import { STATE_DIR } from "@intentic/constants";
import { describe, expect, test } from "vitest";
import { auditBrief, extensionBrief, publishBrief, tightenBrief, updateBrief } from "./extensionBrief";

/* What the brief must not lose. These are not assertions about wording — they are the four things an agent
 * cannot recover on its own, each of which produced a directory that stopped loading when it was missing. */

const brief = extensionBrief({
    id: `workspace.release-notes`,
    dir: `${STATE_DIR}/workspace-extensions/release-notes`,
    wish: `  a list of what shipped this week, from the git log  `,
});

describe(`the brief handed to an authoring agent`, () => {
    test(`carries the author's own words, not a paraphrase of them`, () => {
        // Quoted verbatim (trimmed) so the person and the agent argue about one statement of the goal. A brief
        // that summarised the wish would be the prompt author guessing at a request they were handed exactly.
        expect(brief).toContain(`"a list of what shipped this week, from the git log"`);
    });

    test(`names the two files by path, so nothing has to be searched for`, () => {
        expect(brief).toContain(`.intentic/workspace-extensions/release-notes/extension.js`);
        expect(brief).toContain(`.intentic/workspace-extensions/release-notes/intentic-extension.json`);
    });

    test(`states every constraint that is invisible from inside the directory`, () => {
        // The four ways this goes wrong for an agent that knows Vue and not this host: bundling it, writing an
        // SFC, registering something the manifest never declared, and helping itself to daemon routes.
        expect(brief).toContain(`ONE file`);
        expect(brief).toContain(`h()`);
        expect(brief).toContain(`Declare every contribution`);
        expect(brief).toContain(`permissions.sandbox`);
    });

    test(`ends on something the agent can check rather than claim`, () => {
        // "It still loads" is readable off the Extensions tab, which names a directory that stopped parsing —
        // so finishing is verifiable without the author being there.
        expect(brief).toContain(`Not loadable`);
        expect(brief).toContain(`workspace.release-notes`);
    });
});

describe(`the brief for tightening permissions`, () => {
    const tighten = tightenBrief({
        id: `workspace.release-notes`,
        dir: `${STATE_DIR}/workspace-extensions/release-notes`,
        unused: [`POST /agent`, `GET /panels`],
        used: [{ route: `GET /workspace/file`, calls: 1240 }],
    });

    test(`shows both sides of the evidence, so the claim can be weighed`, () => {
        // The used counts are what make "never called" mean anything: without them the agent cannot tell an
        // exercised extension from one nobody has opened, and both produce the same list of zeroes.
        expect(tighten).toContain(`POST /agent, GET /panels`);
        expect(tighten).toContain(`GET /workspace/file (1,240)`);
    });

    test(`asks for a decision per route, not for the marked ones to be deleted`, () => {
        // The failure this exists to prevent: an agent that treats the panel's marks as a task list and strips a
        // route an error path needs. Keeping one with a reason has to read as success.
        expect(tighten).toContain(`Remove a route only when nothing in the code can reach it`);
        expect(tighten).toContain(`one-line reason`);
    });

    test(`forbids the turn from widening into the code`, () => {
        // Behaviour changes are how a "tidy the manifest" turn becomes a diff nobody can review.
        expect(tighten).toContain(`edits \`permissions.sandbox\` and nothing else`);
    });
});

describe(`the brief for publishing`, () => {
    const publish = publishBrief({
        id: `workspace.release-notes`,
        dir: `${STATE_DIR}/workspace-extensions/release-notes`,
        name: `release-notes`,
    });

    test(`forbids any change between the check and the push`, () => {
        // The one instinct that must be suppressed: a tidy-up between the last test and the push ships bytes
        // nobody ever ran, in a system where the pushed bytes ARE the release.
        expect(publish).toContain(`no tidy-up, no reformat, no version bump`);
    });

    test(`routes discovery through the scan, not a hand-written listing`, () => {
        // The topic is the publish-side half of the nightly scan's contract; a hand-opened pull request beside
        // it makes a maintainer review the same extension twice.
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
        // The branch may have moved since the listing; auditing it would be an account of code nobody is about
        // to run, delivered with full confidence.
        expect(audit).toContain(`a`.repeat(40));
        expect(audit).toContain(`the branch may have moved`);
    });

    test(`is read-only, and says so as a rule rather than a tendency`, () => {
        expect(audit).toContain(`reads and reports; it changes nothing`);
        expect(audit).toContain(`Do not install it`);
    });

    test(`walks the permissions, which are the part worth a stranger's scrutiny`, () => {
        // The manifest names reach; only the code says what uses it. Route-by-route with citations is what
        // makes this an account rather than an impression.
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

    test(`reads the diff, not the tree — the installed commit was already approved`, () => {
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
