import { beforeEach, expect, test } from "vitest";
import { isUnknownSlashCommand, localCommandText, recordCommands, resetCommands, unknownCommandName } from "./agent-commands.js";

beforeEach(() => {
    resetCommands();
});

const publish = (): void => {
    recordCommands("claude", [
        { name: "compact", description: "Compact the context" },
        { name: "review", description: "Review a PR", hint: "<pr>" },
        { name: "iq:iq", description: "Workspace code search" },
    ]);
};

test("a published name runs as a command — with arguments, and with a colon in the name", () => {
    publish();
    expect(isUnknownSlashCommand("claude", "/compact")).toBe(false);
    expect(isUnknownSlashCommand("claude", "/review 4821 please")).toBe(false);
    expect(isUnknownSlashCommand("claude", "/iq:iq where is the parser")).toBe(false);
});

// The failure this exists for: prose whose first word is one of this product's own slash-prefixed nouns. The
// harness would answer "Unknown command" and drop everything after the name.
test("prose that opens with a route, a path or a typo is not a command", () => {
    publish();
    expect(isUnknownSlashCommand("claude", "/workspace view does not remember the file tree")).toBe(true);
    expect(isUnknownSlashCommand("claude", "/agents/{id} shows the wrong branch")).toBe(true);
    expect(isUnknownSlashCommand("claude", "/etc/hosts is stale")).toBe(true);
    expect(isUnknownSlashCommand("claude", "/compct")).toBe(true);
});

test("punctuation after the name is part of the word, so it reads as prose", () => {
    publish();
    expect(isUnknownSlashCommand("claude", "/compact, but only the tool results")).toBe(true);
});

test("a message that does not open with a slash is never touched", () => {
    publish();
    expect(isUnknownSlashCommand("claude", "the /workspace view forgets the tree")).toBe(false);
    expect(isUnknownSlashCommand("claude", "")).toBe(false);
});

// The CLI's own parse is at least this forgiving, so the guard has to be too — reading " /workspace …" as
// prose while the CLI still claims it is exactly the case that loses the message.
test("leading whitespace does not hide the slash", () => {
    publish();
    expect(isUnknownSlashCommand("claude", "  /workspace view forgets the tree")).toBe(true);
});

/* An empty list means "no turn has run since this daemon started", never "this provider has no commands".
 * Guessing there would rewrite a real /compact into prose, so the guard stands down and lets the CLI answer —
 * agent.ts turns that answer into the unknown-command frame the client recovers from. */
test("an unlearned command list stands the guard down rather than guessing", () => {
    expect(isUnknownSlashCommand("claude", "/workspace view forgets the tree")).toBe(false);
    publish();
    expect(isUnknownSlashCommand("codex", "/workspace view forgets the tree")).toBe(false);
});

test("local command output is unwrapped from the tag the transcript stores it under", () => {
    expect(localCommandText("<local-command-stdout>Unknown command: /workspace</local-command-stdout>")).toBe("Unknown command: /workspace");
    expect(localCommandText("  <local-command-stdout>\nSession: 12k tokens\n</local-command-stdout>\n")).toBe("Session: 12k tokens");
    expect(localCommandText("Session: 12k tokens")).toBe("Session: 12k tokens");
});

test("only the unknown-command refusal names a command — every other output is content to show", () => {
    expect(unknownCommandName("Unknown command: /workspace")).toBe("workspace");
    expect(unknownCommandName("Unknown command: compact")).toBe("compact");
    expect(unknownCommandName("Session: 12k tokens")).toBeUndefined();
    expect(unknownCommandName("The docs say: Unknown command: /workspace")).toBeUndefined();
});
