import type { SandboxDefinition } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { definitionDiff, DefinitionFormatError, emitDefinitionToml, parseDefinitionToml } from "./definition.js";

/* The format's promises, held without a daemon: what the emitter writes, the parser reads back IDENTICALLY
 * (a definition is reviewed and committed, so a lossy round-trip is a corrupted review); emission is
 * deterministic byte for byte (drift detection diffs the text); and a document that is not a definition fails
 * with a message naming the field, never by half-parsing. */

const definition: SandboxDefinition = {
    schemaVersion: 1,
    name: "wilson",
    environment: {
        baseImage: "ghcr.io/intentic/sandbox:stable",
        // Backslashes and double quotes on purpose: the multi-line literal block must carry them verbatim,
        // this is the content class (a Dockerfile) the format exists to hold.
        dockerfile: 'RUN apt-get update \\\n  && apt-get install -y ffmpeg\nENV GREETING="hello world"\n',
    },
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

test("not-TOML and TOML-but-not-a-definition each fail with a named reason", () => {
    expect(() => parseDefinitionToml("= this is not toml")).toThrow(DefinitionFormatError);
    expect(() => parseDefinitionToml("schemaVersion = 2\n")).toThrow(/schemaVersion/);
    // An unknown capability kind is refused rather than guessed at, the manifest rule everywhere else.
    expect(() => parseDefinitionToml('schemaVersion = 1\n[[capabilities]]\nid = "x"\nkind = "warp-drive"\nconfig = { }\n')).toThrow(
        DefinitionFormatError,
    );
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

test("a setting spelled at its default is no drift against one that omits it", () => {
    const explicit: SandboxDefinition = { ...definition, settings: { ...definition.settings, terseOutput: false } };
    expect(definitionDiff(definition, explicit)).toEqual([]);
});
