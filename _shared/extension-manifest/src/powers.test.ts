import { z } from "zod";
import { manifestJsonSchema } from "./json-schema.js";
import { ExtensionManifestSchema } from "./manifest.js";
import { powersOf } from "./powers-diff.js";

// Every power the schema declares must COUNT: a manifest that sets the field folds to exactly one more power than the
// same manifest without it, under the key and sentence below. The powers are the owner's approval (a workspace
// extension's digest is taken over their keys), so one the fold silently drops is a power granted without being asked
// for. The list of declared powers is read off the published authoring schema, where each field's `.meta({ power })`
// lands, rather than off the walker under test: a new power with no row here fails, and so does a zod change that
// hides a field from the walker (a union's internals, a wrapper it does not see through).

// What a row sets beyond the identity every manifest carries.
type Fields = Omit<z.input<typeof ExtensionManifestSchema>, "publisher" | "name" | "version" | "engines">;
type Contributes = NonNullable<Fields["contributes"]>;
type Card = NonNullable<Contributes["capabilities"]>[number];

const manifest = (fields: Fields): ReturnType<typeof ExtensionManifestSchema.parse> =>
    ExtensionManifestSchema.parse({ publisher: "acme", name: "demo", version: "1.0.0", engines: { intentic: "^1.0.0" }, ...fields });

const contributes = (points: Contributes, fields: Fields = {}): Fields => ({ ...fields, contributes: points });

const CATALOG = { name: "Acme", description: "One line.", category: "code" };
const CLI_CARD = {
    id: "acme-cli",
    kind: "cli",
    catalog: CATALOG,
    fields: [{ key: "token", label: "Token", secret: true }],
    env: { ACME_TOKEN: "${token}" },
    skill: "skills/acme/SKILL.md",
} satisfies Card;
const VIEW = { id: "board", label: "Board", surface: "rail" } as const;
const COMMAND = { command: "acme.run", title: "Run" };
const SETTING = { key: "token", type: "string", title: "Token" } as const;
const SERVER = { server: "dist/server.js" };
// One card of each kind, so every arm of the capability union is reached through it.
const CARDS: readonly Card[] = [
    CLI_CARD,
    { id: "acme-web", kind: "browser", catalog: CATALOG, fields: [], loginUrl: "https://acme.test/login", skill: "skills/web.md" },
    { id: "acme-os", kind: "device", catalog: CATALOG, fields: [], skill: "skills/os.md" },
    { id: "acme-ext", kind: "webext", catalog: CATALOG, fields: [], skill: "skills/ext.md" },
    { id: "acme-agent", kind: "agent", catalog: CATALOG, fields: [] },
];

interface Row {
    // The power's key template, as the schema declares it.
    readonly power: string;
    readonly without: Fields;
    readonly with: Fields;
    // The one power `with` adds: its filled key and sentence.
    readonly adds: readonly [string, string];
}

const ROWS: readonly Row[] = [
    { power: "entry", without: {}, with: { entry: "dist/extension.js" }, adds: ["entry", "runs a UI bundle in your browser"] },
    { power: "server", without: {}, with: SERVER, adds: ["server", "runs a backend bundle inside the daemon's extension host"] },
    {
        power: "sandbox:${value}",
        without: { permissions: {} },
        with: { permissions: { sandbox: ["POST /panels/*/start"] } },
        adds: ["sandbox:POST /panels/*/start", "its UI calls the sandbox route POST /panels/*/start"],
    },
    {
        power: "daemon:${value}",
        without: { permissions: {} },
        with: { permissions: { daemon: ["GET /workspace/tree"] } },
        adds: ["daemon:GET /workspace/tree", "its backend calls the daemon route GET /workspace/tree"],
    },
    { power: "view:${id}", without: contributes({ views: [] }), with: contributes({ views: [VIEW] }), adds: ["view:board", 'a rail view "Board"'] },
    {
        power: "view-badge:${id}",
        without: contributes({ views: [{ ...VIEW, badge: false }] }),
        with: contributes({ views: [{ ...VIEW, badge: true }] }),
        adds: ["view-badge:board", 'may badge the "Board" tile from any screen'],
    },
    {
        power: "files:${path}",
        without: contributes({ files: [] }),
        // path-literals: content, the extension manifest fixture declares a contributed file path.
        with: contributes({ files: [{ path: ".intentic/config/acme.json", invalidates: ["acme"] }] }),
        adds: ["files:.intentic/config/acme.json", "is told when .intentic/config/acme.json changes"],
    },
    {
        power: "viewer:${id}",
        without: contributes({ viewers: [] }),
        with: contributes({ viewers: [{ id: "office", extensions: ["docx", "xlsx"], fetch: "blob", edit: true, compare: true }] }),
        adds: ["viewer:office", "opens and edits and compares .docx, .xlsx files (blob)"],
    },
    {
        power: "document:${id}",
        without: contributes({ documents: [] }),
        with: contributes({ documents: [{ id: "readmes", label: "Readmes" }] }),
        adds: ["document:readmes", 'marks workspace directories ("Readmes")'],
    },
    {
        power: "side-view:${id}",
        without: contributes({ sideViews: [] }),
        with: contributes({ sideViews: [{ id: "run", label: "CI run" }] }),
        adds: ["side-view:run", 'shows "CI run" in the side panel'],
    },
    {
        power: "side-view-links:${id}",
        without: contributes({ sideViews: [{ id: "run", label: "CI run", links: false }] }),
        with: contributes({ sideViews: [{ id: "run", label: "CI run", links: true }] }),
        adds: ["side-view-links:run", 'opens links it recognises as "CI run" beside the chat'],
    },
    {
        power: "command:${command}",
        without: contributes({ commands: [] }),
        with: contributes({ commands: [COMMAND] }),
        adds: ["command:acme.run", 'a palette command "Run"'],
    },
    {
        power: "keybinding:${command}",
        without: contributes({ commands: [COMMAND] }),
        with: contributes({ commands: [{ ...COMMAND, keybinding: "Mod+Shift+K" }] }),
        adds: ["keybinding:acme.run", 'the global shortcut Mod+Shift+K ("Run")'],
    },
    {
        power: "setting-env:${key}",
        without: contributes({ settings: [SETTING] }),
        with: contributes({ settings: [{ ...SETTING, env: "ACME_TOKEN" }] }),
        adds: ["setting-env:token", `puts the "token" setting into the agent's environment as ACME_TOKEN`],
    },
    {
        power: "process:${name}",
        without: contributes({ processes: [] }),
        with: contributes({ processes: [{ name: "worker", command: "node worker.js", autoStart: true }] }),
        adds: ["process:worker", 'a background process "worker" (starts on boot)'],
    },
    {
        power: "agent",
        without: contributes({}),
        with: contributes({ agent: {} }),
        adds: ["agent", "contributes skills, agents and hooks to the agent's turns"],
    },
    {
        power: "environment",
        without: contributes({}),
        with: contributes({ environment: { fragment: "environment/Dockerfile" } }),
        adds: ["environment", "bakes an environment fragment into the sandbox image"],
    },
    ...CARDS.map((card): Row => ({
        power: "capability:${id}",
        without: contributes({ capabilities: [] }),
        with: contributes({ capabilities: [card] }),
        adds: [`capability:${card.id}`, `a ${card.kind} capability card "Acme"`],
    })),
    {
        power: "capability-tools:${id}",
        without: contributes({ capabilities: [CLI_CARD] }, SERVER),
        with: contributes({ capabilities: [{ ...CLI_CARD, mcp: "mcp" }] }, SERVER),
        adds: ["capability-tools:acme-cli", 'serves MCP tools to the agent for each "Acme" card'],
    },
    {
        power: "listener:${provider}",
        without: contributes({}),
        with: contributes({
            listener: {
                provider: "acme",
                events: [{ type: "message", label: "A message" }],
                automation: { label: "Acme", channel: { label: "Channel", placeholder: "#general" }, starterPrompt: "Answer it." },
            },
        }),
        adds: ["listener:acme", 'a realtime listener provider "acme"'],
    },
    { power: "bin", without: contributes({}), with: contributes({ bin: "bin" }), adds: ["bin", "puts its shipped tools on the agent's PATH"] },
    {
        power: "tools${perCard?-${perCard}:}",
        without: contributes({}, SERVER),
        with: contributes({ tools: {} }, SERVER),
        adds: ["tools", "gives the agent MCP tools"],
    },
    {
        power: "tools${perCard?-${perCard}:}",
        without: contributes({ capabilities: [CLI_CARD] }, SERVER),
        with: contributes({ capabilities: [CLI_CARD], tools: { perCard: "acme-cli" } }, SERVER),
        adds: ["tools-acme-cli", 'gives the agent MCP tools, one server for each "acme-cli" card'],
    },
];

// Every power key template the authoring schema carries, wherever it sits: the serializer visits every node.
const PowerNode = z.object({ power: z.object({ key: z.string() }) });
const declaredPowers = (): Set<string> => {
    const keys = new Set<string>();
    JSON.stringify(manifestJsonSchema(), (_key, node) => {
        const declared = PowerNode.safeParse(node);
        if (declared.success) {
            keys.add(declared.data.power.key);
        }
        return node;
    });
    return keys;
};

describe("powersOf", () => {
    test("a manifest declaring nothing consequential folds to no powers", () => {
        expect([...powersOf(manifest({}))]).toEqual([]);
    });

    test("every power the schema declares has a row below, and every row names a declared power", () => {
        expect([...declaredPowers()].toSorted()).toEqual([...new Set(ROWS.map((row) => row.power))].toSorted());
    });

    test.each(ROWS.map((row) => [row.adds[0], row] as const))("%s counts", (_key, row) => {
        const before = powersOf(manifest(row.without));
        const after = powersOf(manifest(row.with));
        expect([...after].filter(([key]) => !before.has(key))).toEqual([[...row.adds]]);
        expect([...before].filter(([key]) => !after.has(key))).toEqual([]);
    });
});
