import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extensionApiVersion } from "@intentic/extension-api/protocol";

// No build step: the daemon serves `entry` verbatim via a blob URL through the import map, live the moment it exists.
// No permissions block: the strongest starting point, `api.sandbox` throws until a route is added deliberately.
// engines is derived from the host's own extensionApiVersion, so a draft stays compatible with what created it.

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

/* ${labelOf(name)}, a workspace extension, running from its own directory with no build step.
 *
 * Edit this file and reload the extensions to see the change; the daemon serves these bytes directly. Everything
 * this extension is allowed to do is declared in intentic-extension.json beside it, the host refuses any
 * registration the manifest does not name, and \`api.sandbox\` refuses every daemon route until
 * \`permissions.sandbox\` names it. There is no permissions block yet, which is deliberate: add one the first
 * time something here genuinely needs to read from the daemon.
 *
 * Style with the design system's own classes (\`ui-page\`, \`ui-card\`, \`ui-code\`) and role tokens
 * (\`--color-content\`, \`--color-muted\`), they follow the light/dark scheme on their own. The app's utility
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
                    \`This view is drawn by .intentic/config/workspace-extensions/${name}/extension.js.\`,
                ),
                h(\`div\`, { class: \`ui-card\`, style: { marginTop: \`1rem\` } }, [
                    h(\`p\`, { style: { color: \`var(--color-muted)\` } }, \`Nothing here yet, say what you want this to do.\`),
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

A workspace extension: it lives in this workspace, runs from these bytes, and is installed nowhere. It is listed
in the Sandbox hub's Extensions tab as \`${publisher}.${name}\`, where it can be switched off, and it is deleted by
deleting this directory.

| File | What it is |
| --- | --- |
| \`intentic-extension.json\` | What this extension is allowed to do. The host refuses anything it does not declare. |
| \`extension.js\` | The code, as a single ESM file. No build step: the bytes here are the bytes that run. |

## Changing it

Edit \`extension.js\` and reload the extensions from the Extensions tab. If the manifest stops parsing, the tab
says so on this directory's row rather than dropping it silently.

## Reaching the daemon

There is no \`permissions\` block yet, so \`api.sandbox\` refuses every route. When something here genuinely needs
to read from the daemon, add the one route it needs:

\`\`\`json
"permissions": { "sandbox": ["GET /workspace/repos"] }
\`\`\`

Keeping that list to what is actually used is the whole point of it: it is what an owner reads before trusting
this extension anywhere else.

## Publishing it

A workspace extension is a draft. Publishing means putting this directory in a git repository of its own, building
a bundle if it has grown past one file, and listing the commit in a registry: at which point the sha, not this
directory, is what people run.
`;

// Writes a new workspace extension's directory; refuses to overwrite, since an existing one may be someone else's work.
// There's no install moment or checkout to recover from, so silently replacing it would destroy work for good.
export const writeWorkspaceExtension = async (dir: string, publisher: string, name: string): Promise<void> => {
    // Root created on demand; the extension's own dir is non-recursive, so an existing one raises EEXIST.
    await mkdir(dirname(dir), { recursive: true });
    await mkdir(dir, { recursive: false });
    await writeFile(join(dir, `intentic-extension.json`), manifestOf(publisher, name), `utf8`);
    await writeFile(join(dir, `extension.js`), entryOf(name), `utf8`);
    await writeFile(join(dir, `README.md`), readmeOf(publisher, name), `utf8`);
};
