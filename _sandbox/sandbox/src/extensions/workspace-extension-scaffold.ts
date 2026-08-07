import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extensionApiVersion } from "@intentic/extension-api";

/* THE FILES A NEW WORKSPACE EXTENSION IS BORN WITH — and the two decisions that shape all of them.
 *
 * NO BUILD STEP. The scaffold is one hand-written ESM file, not a vite project, because a workspace extension is
 * loaded by its BYTES: the daemon serves `entry` verbatim and the host imports it from a blob URL whose bare
 * specifiers resolve through the shell's import map (hostModules.ts). `import { h } from "vue"` therefore lands
 * on the shell's own vue with nothing compiled and nothing installed — so the extension is running the moment the
 * directory exists, and an edit to it is live on the next host reload. Scaffolding a project with a `dist/` the
 * author must first `npm install && npm run build` to fill would mean the opposite: a listed, un-runnable
 * extension until they got the toolchain right. The published templates build because they must ship a bundle to
 * a stranger; a workspace draft ships to nobody.
 *
 * Hence `h()` rather than an SFC: Vue's runtime in the shell has no template compiler, and a vite lib build emits
 * an SFC's <style> as a separate asset nothing would fetch. Styling is the design system's authored `.ui-*`
 * classes and role tokens, the same constraint a published extension lives under.
 *
 * NO PERMISSIONS. The manifest has no `permissions` block at all, which is the strongest thing a starting point
 * can say: this extension may reach no daemon route whatsoever, and `api.sandbox` throws if it tries. Every route
 * it eventually reaches has to be added deliberately, by someone who knows why — which is the same review the
 * owner performs at install, moved to the moment the need appears instead of the moment before publication. The
 * alternative (scaffold the permissions a demo happens to use) trains authors to inherit reach they never chose.
 *
 * The engines range is derived from the host's own extensionApiVersion rather than written down, so a draft
 * created today is compatible with the app that created it and nothing has to remember to bump it. */

// A directory name that cannot escape the workspace-extensions root and cannot collide with the dot-prefixed
// names the enumerator skips. The same shape the manifest schema demands of `name`, checked here because this is
// where it becomes a path.
export const WORKSPACE_EXTENSION_NAME = /^[a-z0-9][a-z0-9-]*$/;

// Title Case for the label a tile carries, derived from the slug so the author names the thing once.
const labelOf = (name: string): string =>
    name
        .split(`-`)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(` `);

const manifestOf = (publisher: string, name: string): string =>
    `${JSON.stringify(
        {
            publisher,
            name,
            version: `0.1.0`,
            icon: `sparkles`,
            engines: { intentic: `^${extensionApiVersion}` },
            entry: `extension.js`,
            contributes: { views: [{ id: name, label: labelOf(name), surface: `rail` }] },
        },
        undefined,
        4,
    )}\n`;

const entryOf = (name: string): string => `import { defineComponent, h } from "vue";

/* ${labelOf(name)} — a workspace extension, running from its own directory with no build step.
 *
 * Edit this file and reload the extensions to see the change; the daemon serves these bytes directly. Everything
 * this extension is allowed to do is declared in intentic-extension.json beside it — the host refuses any
 * registration the manifest does not name, and \`api.sandbox\` refuses every daemon route until
 * \`permissions.sandbox\` names it. There is no permissions block yet, which is deliberate: add one the first
 * time something here genuinely needs to read from the daemon.
 *
 * Style with the design system's own classes (\`ui-page\`, \`ui-card\`, \`ui-code\`) and role tokens
 * (\`--color-content\`, \`--color-muted\`) — they follow the light/dark scheme on their own. The app's utility
 * classes are NOT reliably available here, because its CSS build never saw this file. */

const View = defineComponent({
    name: \`${labelOf(name).replace(/ /gu, ``)}View\`,
    setup() {
        return () =>
            h(\`div\`, { class: \`ui-page\` }, [
                h(\`h1\`, { style: { fontSize: \`1.25rem\`, fontWeight: 600, color: \`var(--color-content)\` } }, \`${labelOf(name)}\`),
                h(
                    \`p\`,
                    { style: { color: \`var(--color-muted)\`, marginTop: \`0.25rem\` } },
                    \`This view is drawn by .intentic/workspace-extensions/${name}/extension.js.\`,
                ),
                h(\`div\`, { class: \`ui-card\`, style: { marginTop: \`1rem\` } }, [
                    h(\`p\`, { style: { color: \`var(--color-muted)\` } }, \`Nothing here yet — say what you want this to do.\`),
                ]),
            ]);
    },
});

export const activate = (api, context) => {
    context.subscriptions.push(
        api.views.register({
            id: \`${name}\`,
            label: \`${labelOf(name)}\`,
            surface: \`rail\`,
            // One activation, unconditionally: this view is about the workspace, not about any repo in it. A view
            // that IS about repos filters the \`repos\` argument here and returns one activation each.
            detect: () => [{ key: \`${name}\`, title: \`${labelOf(name)}\`, icon: \`sparkles\` }],
            view: async () => View,
        }),
    );
};
`;

const readmeOf = (publisher: string, name: string): string => `# ${labelOf(name)}

A workspace extension — it lives in this workspace, runs from these bytes, and is installed nowhere. It is listed
in the Sandbox hub's Extensions tab as \`${publisher}.${name}\`, where it can be switched off, and it is deleted by
deleting this directory.

| File | What it is |
| --- | --- |
| \`intentic-extension.json\` | What this extension is allowed to do. The host refuses anything it does not declare. |
| \`extension.js\` | The code, as a single ESM file. No build step — the bytes here are the bytes that run. |

## Changing it

Edit \`extension.js\` and reload the extensions from the Extensions tab. If the manifest stops parsing, the tab
says so on this directory's row rather than dropping it silently.

## Reaching the daemon

There is no \`permissions\` block yet, so \`api.sandbox\` refuses every route. When something here genuinely needs
to read from the daemon, add the one route it needs:

\`\`\`json
"permissions": { "sandbox": ["GET /workspace/repos"] }
\`\`\`

Keeping that list to what is actually used is the whole point of it — it is what an owner reads before trusting
this extension anywhere else.

## Publishing it

A workspace extension is a draft. Publishing means putting this directory in a git repository of its own, building
a bundle if it has grown past one file, and listing the commit in a registry — at which point the sha, not this
directory, is what people run.
`;

/* Write a new workspace extension's directory. Refuses to overwrite: an existing directory is somebody else's
 * extension (or an earlier attempt worth looking at), and silently replacing it would destroy work the author
 * cannot get back — there is no install moment and no checkout to re-clone from. */
export const writeWorkspaceExtension = async (dir: string, publisher: string, name: string): Promise<void> => {
    // The root is created on demand (a workspace has none until its first extension); the extension's own
    // directory is NOT recursive, so an existing one raises EEXIST instead of being written into.
    await mkdir(dirname(dir), { recursive: true });
    await mkdir(dir, { recursive: false });
    await writeFile(join(dir, `intentic-extension.json`), manifestOf(publisher, name), `utf8`);
    await writeFile(join(dir, `extension.js`), entryOf(name), `utf8`);
    await writeFile(join(dir, `README.md`), readmeOf(publisher, name), `utf8`);
};
