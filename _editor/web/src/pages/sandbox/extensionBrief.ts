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
