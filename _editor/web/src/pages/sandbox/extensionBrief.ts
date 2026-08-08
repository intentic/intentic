import { composeAsk } from "@intentic/sandbox-contract/chores";

/* WHAT WE SAY TO AN AGENT HANDED A NEW EXTENSION.
 *
 * The author has described something they wish this workspace could do, and a working extension already exists to
 * do it in. What the agent is missing is not the wish — that is quoted verbatim — but the five rules a workspace
 * extension lives under, every one of which is invisible from inside the directory and expensive to learn by
 * failing. An agent that knows Vue and does not know these writes a vite project with an SFC, a relative import
 * and a permissions list copied from an example, and produces a directory that no longer runs.
 *
 * The four-part shape and `composeAsk` come from @intentic/sandbox-contract/chores, the same builder the chore
 * book and the codebase-health panel ask through — a generated prompt reads the same wherever this product
 * generates one. What is local is the invariants, because they are about this contribution surface and nothing
 * else. */

const AUTHORING_INVARIANTS =
    // Each clause is a specific way the turn ends with a directory that does not load. Stated in full every time
    // rather than assumed, because the agent reading this has no other source for any of them.
    `Keep it loadable, which constrains HOW more than it constrains what. The entry file is served to the browser ` +
    `byte for byte and imported from a blob URL, so it stays ONE file whose only imports are bare specifiers the ` +
    `host publishes (\`vue\`, \`@intentic/extension-api\`, \`@intentic/extension-ui\`, \`@tanstack/vue-query\`) — a ` +
    `relative import cannot resolve at activation, and introducing a bundler leaves the directory dead until ` +
    `something builds it. Build components with \`h()\`: the shell's Vue has no template compiler, and a single-file ` +
    `component's styles would be emitted as an asset nothing fetches. Declare every contribution in ` +
    `intentic-extension.json as well as registering it in code — the host refuses a registration the manifest never ` +
    `named, which reads like broken code rather than a missing line. Style with the design system's \`ui-\` classes ` +
    `and role tokens (\`--color-content\`, \`--color-muted\`); the app's utility classes were never compiled for this ` +
    `file. And leave \`permissions.sandbox\` alone unless something genuinely needs the daemon: add only the exact ` +
    `route it needs, and say in your summary what reads it, because that list is what an owner weighs before ` +
    `trusting this anywhere.`;

// What the scaffold IS, so the agent starts from the code rather than from an assumption about it. Worth stating
// because the honest answer is "almost nothing" — an agent told only the wish tends to assume a half-built thing
// it must reverse-engineer, and reads the two files defensively instead of replacing what it finds.
const SCAFFOLD = `It currently contributes one rail view that draws placeholder text, and declares no permissions at all.`;

export interface ExtensionBrief {
    // publisher.name — the identity it is listed under, and what the author will look for on the Extensions tab.
    readonly id: string;
    // Workspace-root-relative directory holding the manifest and the entry file.
    readonly dir: string;
    // The author's own words for what they want, verbatim. Never paraphrased into the prompt: the agent and the
    // person have to be working from one statement of the goal, and this is the only part the person wrote.
    readonly wish: string;
}

export const extensionBrief = ({ id, dir, wish }: ExtensionBrief): string =>
    composeAsk({
        subject: `Build the ${id} extension, which lives in ${dir} of this workspace.`,
        why: `Its author asked for this: "${wish.trim()}"`,
        diagnosis: SCAFFOLD,
        // Deliberately not a design. Whoever pressed the button has not read the code either, and a prescribed
        // structure from out here would be a guess wearing an instruction's clothes — the same reason the chore
        // book states shape rather than solution.
        goal: `Make it do that, editing ${dir}/extension.js and ${dir}/intentic-extension.json together. Where the ask is bigger than one view, do the smallest version of it that genuinely works and say what you left.`,
        invariants: AUTHORING_INVARIANTS,
        // Falsifiable, and checkable without the author: a directory that stopped parsing is reported by name on
        // the Extensions tab, so "it still loads" is something the agent can go and read rather than assert.
        done: `Done when the Extensions tab still lists ${id} outside its "Not loadable" group after reloading the extensions, and its view draws what was asked for.`,
    });

/* TIGHTENING THE PERMISSIONS, once the ledger has something to say.
 *
 * The measurement is the whole reason this turn can be asked for at all, and it is also the reason the turn must
 * not be mechanical. "Never called" is evidence of one thing only: nobody exercised the path that would have
 * called it, in this workspace, since the counting started. An error handler that has never fired, a view nobody
 * has opened, a route reached once a month — every one of those reads identically to a permission that was
 * copied in and never needed. So the ask is to READ the code and decide, not to delete the rows the panel
 * marked, and leaving one in with a reason written down is a good outcome rather than a failure to act. */
const TIGHTEN_INVARIANTS =
    `Read the extension's code before you touch its manifest. Remove a route only when nothing in the code can ` +
    `reach it; where something can, leave it and say in one line what calls it and why it has not been observed — ` +
    `an error path, a screen nobody opened, a monthly job. Change no behaviour: this turn edits ` +
    `\`permissions.sandbox\` and nothing else, and if that would mean editing code to make a route unnecessary, ` +
    `propose it instead of doing it.`;

export interface TightenBrief {
    readonly id: string;
    readonly dir: string;
    // The declared routes with no observed call, and how long the ledger has been watching — both are needed to
    // weigh a "never", and the agent should be able to argue the evidence is too thin.
    readonly unused: readonly string[];
    // The declared routes that ARE used, with their counts, phrased for the prompt. Present so the agent can see
    // the extension has genuinely been exercised rather than take the claim on trust.
    readonly used: readonly { readonly route: string; readonly calls: number }[];
}

export const tightenBrief = ({ id, dir, unused, used }: TightenBrief): string =>
    composeAsk({
        subject: `Tighten the daemon routes ${id} asks for, in ${dir}/intentic-extension.json.`,
        why: `Of the routes it declares, these have never been observed being called: ${unused.join(`, `)}. These have: ${used.map((route) => `${route.route} (${route.calls.toLocaleString()})`).join(`, `)}.`,
        diagnosis: `The counts come from the host's own permission gate, which records which declared entry covered each call — so the used ones are certain, and an unused one only means nothing exercised it here.`,
        goal: `Decide, route by route, whether the extension still needs it. The result is a shorter permissions list, a note for each route you kept, or a reasoned "leave it as it is".`,
        invariants: TIGHTEN_INVARIANTS,
        done: `Done when every route in the list is either gone or has a one-line reason, and the extension still loads and works after reloading the extensions.`,
    });

/* PUBLISHING, as a turn the author watches rather than a pipeline they trust.
 *
 * The mechanics are a git ritual the agent already knows how to perform — init, push, read the sha back — so the
 * brief spends its words on the two things that make an extension publication different from pushing any other
 * directory. First: THE BYTES ARE THE RELEASE. There is no build step at install, so whatever is in the
 * directory at the pushed commit is literally the code that runs in every installer's browser, and "clean up
 * before publishing" is the one instinct that must be suppressed — a tidy-up between the last test and the push
 * ships code nobody ever ran. Second: THE SHA IS THE IDENTITY. A listing pins a commit, installs follow the
 * pointer, and nothing about the repository after that commit matters — so the turn ends by reporting the sha,
 * because that string is the thing the author does everything else with. */
const PUBLISH_INVARIANTS =
    `Publish the directory exactly as it is: no tidy-up, no reformat, no version bump, no regenerated files ` +
    `between checking it and pushing it — the pushed bytes are the code every installer runs, so any change after ` +
    `the check ships something nobody verified. Create the repository under the owner's account and push this one ` +
    `directory as its root. Add the "intentic-extension" topic on GitHub — that is what the registry's nightly ` +
    `scan discovers repositories by. Do not open a listing pull request yourself unless asked: the scan writes ` +
    `one overnight, and a hand-written duplicate costs a maintainer two reviews of the same thing.`;

export interface PublishBrief {
    readonly id: string;
    readonly dir: string;
    // The extension's name — the conventional repository name is derived from it.
    readonly name: string;
}

export const publishBrief = ({ id, dir, name }: PublishBrief): string =>
    composeAsk({
        subject: `Publish the ${id} extension, whose files are in ${dir} of this workspace.`,
        why: `Its readiness checks pass here, and publishing is the step that makes those checks matter: a workspace extension runs only in this workspace, and a published one is a repository plus a commit sha that any sandbox can install.`,
        diagnosis: `The workspace's git credentials are already connected, so git and the GitHub API both work from the shell. The conventional repository name is intentic-${name}.`,
        goal: `Turn the directory into a public repository at a commit: initialise it if it is not a repository yet, commit everything as it stands, push, and confirm the pushed tree matches the directory byte for byte.`,
        invariants: PUBLISH_INVARIANTS,
        done: `Done when the repository exists with the topic set and you have reported the pushed commit sha — that sha is the extension's identity: what a registry lists, what an installer pins, and what the next publish replaces.`,
    });

/* READING AN EXTENSION BEFORE IT IS INSTALLED — the adoption side's half of the trust story.
 *
 * Everything else in this pipeline serves the author; this serves the stranger about to run their code. The
 * install dialog already shows what the manifest DECLARES, and the registry's checks already say the thing
 * LOADS — what neither can say is whether the code does what the description claims and nothing else, and the
 * one party with perfect incentives to answer that is the owner's own agent, reading the exact commit cold.
 *
 * The gate does not move. This turn reads and reports; installing stays the same manifest approval it always
 * was, made by the same person — now with an account of the code in front of them instead of a description
 * written by the person selling it. */
const AUDIT_INVARIANTS =
    `This turn reads and reports; it changes nothing. Clone into a scratch directory outside the workspace, at ` +
    `that exact commit — the branch may have moved and is not what would be installed. Do not install it, do not ` +
    `add a capability, and do not run its code; read it. Go permission by permission through the manifest's ` +
    `\`permissions.sandbox\` and say what in the code calls each route, quoting file and line — reach nothing in ` +
    `the code uses is worth saying too. Report in the owner's terms (what it draws, what it reads, where anything ` +
    `it reads could go), and if anything in the code does not match the extension's own description, lead with that.`;

export interface AuditBrief {
    // The listing's display name, or the repository when it is being installed straight from a URL.
    readonly label: string;
    readonly url: string;
    // The full commit sha the install would pin — the audit's whole subject.
    readonly ref: string;
    // Subdirectory inside the repository, for a monorepo source. Empty for a repo of its own.
    readonly path: string;
}

export const auditBrief = ({ label, url, ref, path }: AuditBrief): string =>
    composeAsk({
        subject: `Read the ${label} extension before it is installed here: ${url} at commit ${ref}${path === `` ? `` : `, in ${path}`}.`,
        why: `The owner is about to install it. Installed, its bundle runs in their browser and may call every daemon route its manifest declares — so the question is not whether it loads, but whether the code does what its description says and nothing else.`,
        diagnosis: `The manifest (intentic-extension.json at the extension root) is the whole contract: contributions the host will accept, and the daemon routes the code may reach. Everything else is ordinary source to read.`,
        goal: `Clone it at that commit, read the manifest and every source file, and write the account the install dialog cannot: what it actually does, route by route and contribution by contribution.`,
        invariants: AUDIT_INVARIANTS,
        done: `Done when you end on a recommendation the owner can act on — install it, install it and keep an eye on something named, or do not — with the code that decided it cited by file and line.`,
    });

/* AN UPDATE, READ AS A DIFF. The commit that is installed was approved once already — re-reading all of it
 * would bury the one question an update asks: what is different, and did any of it change the deal? So the
 * turn's subject is the diff between the two commits, and the manifest's delta leads, because a new entry in
 * `permissions.sandbox` is reach the owner never approved, arriving dressed as an update. */
const UPDATE_INVARIANTS =
    `This turn reads and reports; it changes nothing and installs nothing. Clone into a scratch directory ` +
    `outside the workspace and read the diff between the two commits — the installed code was approved once ` +
    `already, so what is between them is the whole subject. Lead with the manifest's delta: any route added to ` +
    `\`permissions.sandbox\` is reach the owner never approved and the headline whatever else changed. Then the ` +
    `code: what behaviour changed, in the owner's terms, citing file and line.`;

export interface UpdateBrief {
    readonly label: string;
    readonly url: string;
    // What is installed and what the update proposes — both full shas, both facts, neither a branch.
    readonly fromRef: string;
    readonly toRef: string;
    readonly path: string;
}

export const updateBrief = ({ label, url, fromRef, toRef, path }: UpdateBrief): string =>
    composeAsk({
        subject: `Read what changed in the ${label} extension before it is updated here: ${url}, from ${fromRef} to ${toRef}${path === `` ? `` : `, in ${path}`}.`,
        why: `The installed commit was approved once already; the update replaces it wholesale, because the sha is the identity and there is no build step between the pushed bytes and the code that runs.`,
        diagnosis: `The manifest (intentic-extension.json at the extension root) is the contract on both sides of the diff, so its delta is readable exactly like the code's.`,
        goal: `Read the diff and say what the update actually is: the manifest delta first, then what the code now does that it did not, and what it stopped doing.`,
        invariants: UPDATE_INVARIANTS,
        done: `Done when you end on a recommendation the owner can act on — update, update and watch something named, or stay on ${fromRef.slice(0, 7)} — with the change that decided it cited by file and line.`,
    });
