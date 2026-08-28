import type { SandboxDefinition } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { definitionDiff, DefinitionFormatError, emitDefinitionToml, parseDefinitionToml, settingsDefinition, settingsDrift } from "./definition.js";

/* The format's promises, held without a daemon: what the emitter writes, the parser reads back IDENTICALLY
 * (a definition is reviewed and committed, so a lossy round-trip is a corrupted review); emission is
 * deterministic byte for byte (drift detection diffs the text); and a document that is not a definition fails
 * with a message naming the field, never by half-parsing. */

const definition: SandboxDefinition = {
    schemaVersion: 2,
    name: "wilson",
    environment: {
        baseImage: "ghcr.io/intentic/sandbox:stable",
        // Backslashes and double quotes on purpose: the multi-line literal block must carry them verbatim,
        // this is the content class (a Dockerfile) the format exists to hold.
        dockerfile: 'RUN apt-get update \\\n  && apt-get install -y ffmpeg\nENV GREETING="hello world"\n',
    },
    workspace: { remote: "https://github.com/example/workspace.git", ref: "main" },
    repositories: [
        { id: "intentic", remote: "https://github.com/example/intentic.git", ref: "main" },
        { id: "clients/site", remote: "git@github.com:example/site.git" },
    ],
    capabilities: [{ id: "linear", kind: "mcp", config: { url: "https://mcp.linear.app/sse" } }],
    secrets: ["OPENAI_API_KEY", "SLACK_WEBHOOK_URL"],
    settings: { workspaceMap: true, terseHoldout: 0.25 },
};

test("emit → parse is the identity, dockerfile bytes included", () => {
    const parsed = parseDefinitionToml(emitDefinitionToml(definition));
    expect(parsed).toEqual(definition);
});

test("emission is deterministic and stable across a round trip", () => {
    const first = emitDefinitionToml(definition);
    expect(emitDefinitionToml(definition)).toBe(first);
    expect(emitDefinitionToml(parseDefinitionToml(first))).toBe(first);
});

test("omitted notes ride as comments and change nothing for the parser", () => {
    const withNotes = emitDefinitionToml(definition, [{ subject: "Repository scratch", detail: "No remote configured." }]);
    expect(withNotes).toContain("# Left out of this export");
    expect(parseDefinitionToml(withNotes)).toEqual(definition);
});

test("a dockerfile the literal block cannot hold falls back to an escaped string and still round-trips", () => {
    const awkward: SandboxDefinition = {
        ...definition,
        environment: { dockerfile: "RUN echo '''tricky'''\n" },
    };
    expect(parseDefinitionToml(emitDefinitionToml(awkward))).toEqual(awkward);
});

test("a dockerfile without a final newline keeps that exact byte shape", () => {
    const noFinalNewline: SandboxDefinition = {
        ...definition,
        environment: { dockerfile: "RUN true" },
    };
    const emitted = emitDefinitionToml(noFinalNewline);
    expect(emitted).toContain('dockerfile = "RUN true"');
    expect(parseDefinitionToml(emitted)).toEqual(noFinalNewline);
});

test("not-TOML and TOML-but-not-a-definition each fail with a named reason", () => {
    expect(() => parseDefinitionToml("= this is not toml")).toThrow(DefinitionFormatError);
    expect(() => parseDefinitionToml("schemaVersion = 1\n")).toThrow(/schemaVersion/);
    expect(() => parseDefinitionToml("schemaVersion = 3\n")).toThrow(/schemaVersion/);
    // An unknown capability kind is refused rather than guessed at, the manifest rule everywhere else.
    expect(() => parseDefinitionToml('schemaVersion = 2\n[[capabilities]]\nid = "x"\nkind = "warp-drive"\nconfig = { }\n')).toThrow(
        DefinitionFormatError,
    );
});

test("unknown document and workspace fields are refused instead of silently stripped", () => {
    expect(() => parseDefinitionToml("schemaVersion = 2\nsurprise = true\n")).toThrow(/surprise/);
    expect(() => parseDefinitionToml('schemaVersion = 2\n[workspace]\nremote = "https://example.com/workspace.git"\nbranch = "release"\n')).toThrow(
        /branch/,
    );
    expect(() =>
        parseDefinitionToml(
            'schemaVersion = 2\n[[capabilities]]\nid = "linear"\nkind = "mcp"\nconfig = { url = "https://mcp.example.com", typo = true }\n',
        ),
    ).toThrow(/capabilities\[0\]\.config\.typo/);
});

test("diff answers empty for agreement and one line per real difference", () => {
    expect(definitionDiff(definition, definition)).toEqual([]);

    const drifted: SandboxDefinition = {
        ...definition,
        repositories: [
            { id: "intentic", remote: "https://github.com/example/intentic.git", ref: "release" },
            { id: "extra", remote: "https://github.com/example/extra.git" },
        ],
        capabilities: [],
        secrets: ["OPENAI_API_KEY", "NEW_KEY"],
        settings: { workspaceMap: false },
    };
    const subjects = definitionDiff(definition, drifted).map((difference) => difference.subject);
    expect(subjects).toContain("Repository intentic"); // ref changed
    expect(subjects).toContain("Repository extra"); // in the definition, not here
    expect(subjects).toContain("Repository clients/site"); // here, not in the definition
    expect(subjects).toContain("Connection linear"); // here, not in the definition
    expect(subjects).toContain("Secret NEW_KEY"); // named, no value stored
    expect(subjects).toContain("Setting workspaceMap");
    expect(subjects).toContain("Setting terseHoldout"); // absent in target ⇒ default, differs from 0.25
});

test("the workspace section drifts in three directions, and a definition without one is not silence", () => {
    const { workspace: _dropped, ...unpublished } = definition;
    // Not naming a workspace against a published one is a real difference, not agreement by omission: it is
    // the difference between a document that carries the sandbox's own content and one that does not.
    expect(definitionDiff(definition, unpublished as SandboxDefinition)).toEqual([
        {
            subject: "Workspace",
            detail: "This workspace is published at https://github.com/example/workspace.git @ main; the definition names none.",
        },
    ]);
    expect(definitionDiff(unpublished as SandboxDefinition, definition)).toEqual([
        { subject: "Workspace", detail: "The definition names https://github.com/example/workspace.git @ main; this workspace has no remote." },
    ]);
    const moved: SandboxDefinition = { ...definition, workspace: { remote: "https://github.com/example/workspace.git", ref: "template" } };
    expect(definitionDiff(definition, moved).map((difference) => difference.subject)).toEqual(["Workspace"]);
});

test("a setting spelled at its default is no drift against one that omits it", () => {
    const explicit: SandboxDefinition = { ...definition, settings: { ...definition.settings, terseOutput: false } };
    expect(definitionDiff(definition, explicit)).toEqual([]);
});

/* ---- the runner-scoped surfaces: the settings-only definition and its drift lines ---- */

test("settingsDefinition is settings-only: non-defaults in, every other section empty", async () => {
    const services = { sandboxSettings: { get: async () => ({ terseOutput: true, hashlineEdits: false }) } };
    const scoped = await settingsDefinition(services as unknown as Parameters<typeof settingsDefinition>[0]);
    // The default-valued flag is dropped (stating it would freeze today's default into every future apply);
    // nothing else grows a section, which is what makes this safe to ship to a runner.
    expect(scoped.settings).toEqual({ terseOutput: true });
    // No workspace either: a runner's tree arrives through the parent's git door, never by cloning a remote.
    expect(scoped.workspace).toBeUndefined();
    expect(scoped.repositories).toEqual([]);
    expect(scoped.capabilities).toEqual([]);
    expect(scoped.secrets).toEqual([]);
    expect(scoped.environment).toEqual({});
    // And it rides the ordinary emitter/parser unchanged — the property the hello and the sync door lean on.
    expect(parseDefinitionToml(emitDefinitionToml(scoped))).toEqual(scoped);
});

test("settingsDrift names each differing key once, with defaults meaning agreement", () => {
    const scoped = (settings: SandboxDefinition["settings"]): SandboxDefinition => ({
        schemaVersion: 2,
        environment: {},
        repositories: [],
        capabilities: [],
        secrets: [],
        settings,
    });
    // Agreement, spelled two ways: both omit, and one side states the default the other omits.
    expect(settingsDrift(scoped({}), scoped({}))).toEqual([]);
    expect(settingsDrift(scoped({ terseOutput: false }), scoped({}))).toEqual([]);
    // One real difference, one line, subject the sync surfaces key off ("Setting …").
    const lines = settingsDrift(scoped({ terseOutput: true }), scoped({}));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.subject).toBe("Setting terseOutput");
    expect(lines[0]?.detail).toContain("This sandbox runs true");
});
