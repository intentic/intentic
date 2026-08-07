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
