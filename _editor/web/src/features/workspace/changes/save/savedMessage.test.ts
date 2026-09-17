import type { GitChange, LandedMessage, RepoChanges } from "@intentic/api-contract";
import { describe, expect, test } from "vitest";
import { OWN_EDITS_SUBJECT, savedMessage, soleOrigin } from "./savedMessage";

const change = (path: string, status: GitChange[`status`] = `modified`): GitChange => ({ path, status });
const repo = (name: string, sides: Partial<Pick<RepoChanges, `conflicted` | `staged` | `unstaged` | `origins` | `truncated`>>): RepoChanges => ({
    repo: name,
    conflicted: [],
    staged: [],
    unstaged: [],
    ...sides,
});

const wrote =
    (subject: string): ((id: string) => LandedMessage | undefined) =>
    () => ({ subject });
const wroteNothing = (): undefined => undefined;

describe(`soleOrigin`, () => {
    test(`names the one assistant every file came from, across repos`, () => {
        const repos = [
            repo(`root`, { unstaged: [change(`a.md`)], origins: { "a.md": [`agent-1`] } }),
            repo(`site`, { staged: [change(`b.md`)], origins: { "b.md": [`agent-1`] } }),
        ];
        expect(soleOrigin(repos)).toBe(`agent-1`);
    });

    test(`refuses a tree two assistants wrote into`, () => {
        const repos = [repo(`root`, { unstaged: [change(`a.md`), change(`b.md`)], origins: { "a.md": [`agent-1`], "b.md": [`agent-2`] } })];
        expect(soleOrigin(repos)).toBeUndefined();
    });

    test(`refuses a file the owner edited themselves: no origin means their own hand`, () => {
        const repos = [repo(`root`, { unstaged: [change(`a.md`), change(`mine.md`)], origins: { "a.md": [`agent-1`] } })];
        expect(soleOrigin(repos)).toBeUndefined();
    });

    test(`refuses a truncated repo: the rows the daemon dropped could carry any origin`, () => {
        const repos = [repo(`root`, { unstaged: [change(`a.md`)], origins: { "a.md": [`agent-1`] }, truncated: { staged: 0, unstaged: 40 } })];
        expect(soleOrigin(repos)).toBeUndefined();
    });

    test(`is undefined for a clean tree, which no landing describes`, () => {
        expect(soleOrigin([repo(`root`, {})])).toBeUndefined();
    });
});

describe(`savedMessage`, () => {
    test(`spends the sentence the model already wrote for that landing`, () => {
        const repos = [repo(`root`, { unstaged: [change(`a.md`)], origins: { "a.md": [`agent-1`] } })];
        expect(savedMessage(repos, wrote(`Rewrite the pricing page`))).toEqual({ message: `Rewrite the pricing page`, from: `agent-1` });
    });

    test(`carries the landing's trailers, as a commit of it would`, () => {
        const repos = [repo(`root`, { unstaged: [change(`a.md`)], origins: { "a.md": [`agent-1`] } })];
        const message = savedMessage(repos, () => ({ subject: `Raise the price`, note: `Prices changed` })).message;
        expect(message).toBe(`Raise the price\n\nRelease-Note: Prices changed`);
    });

    test(`falls back to the constant when no message was written for that landing`, () => {
        const repos = [repo(`root`, { unstaged: [change(`a.md`)], origins: { "a.md": [`agent-1`] } })];
        expect(savedMessage(repos, wroteNothing)).toEqual({ message: OWN_EDITS_SUBJECT });
    });

    test(`falls back for the owner's own edits, naming nobody`, () => {
        const repos = [repo(`root`, { unstaged: [change(`mine.md`)] })];
        expect(savedMessage(repos, wrote(`never asked`))).toEqual({ message: OWN_EDITS_SUBJECT });
    });
});
