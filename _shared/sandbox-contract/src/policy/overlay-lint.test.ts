import { expect, test } from "vitest";
import { hasOfficialBase, invalidExtensionFragment, isOfficialSandboxImage, lintOverlay, overlayBase, rewriteOverlayBase } from "./overlay-lint.js";

test("accepts a RUN/ENV-only fragment, comments and blank lines included", () => {
    const fragment = `# install the postgres client\nRUN apt-get update && apt-get install -y postgresql-client\nENV PGCLIENT=1\n`;
    expect(invalidExtensionFragment(fragment)).toBeUndefined();
});

test("accepts a line-continued RUN body", () => {
    const fragment = `RUN set -eux; \\\n    apt-get update; \\\n    apt-get install -y whisper\n`;
    expect(invalidExtensionFragment(fragment)).toBeUndefined();
});

test("rejects FROM in a fragment (the daemon owns the base pin)", () => {
    expect(invalidExtensionFragment(`FROM ubuntu:24.04\nRUN echo hi`)).toBe(`FROM ubuntu:24.04`);
});

test("rejects a non-RUN/ENV instruction in a fragment", () => {
    expect(invalidExtensionFragment(`RUN echo ok\nCOPY x /x`)).toBe(`COPY x /x`);
    expect(invalidExtensionFragment(`USER root`)).toBe(`USER root`);
});

test("rejects a privileged runtime directive, even hidden in a comment or a continued body", () => {
    expect(invalidExtensionFragment(`# intentic:runtime --privileged`)).toBe(`# intentic:runtime --privileged`);
    expect(invalidExtensionFragment(`RUN true \\\n    # intentic:runtime --cap-add=NET_ADMIN`)).toBe(`    # intentic:runtime --cap-add=NET_ADMIN`);
});

test("the official image is the published sandbox under any tag", () => {
    expect(isOfficialSandboxImage(`ghcr.io/intentic/sandbox:stable`)).toBe(true);
    expect(isOfficialSandboxImage(`ghcr.io/intentic/sandbox:1.52.0`)).toBe(true);
    expect(isOfficialSandboxImage(`ghcr.io/intentic/sandbox:`)).toBe(false);
    expect(isOfficialSandboxImage(`intentic-sandbox:dev`)).toBe(false);
    expect(isOfficialSandboxImage(`ghcr.io/intentic/sandbox:stable extra`)).toBe(false);
});

test("overlayBase reads the first instruction's FROM and nothing else", () => {
    expect(overlayBase(`# composed\n\nFROM ghcr.io/intentic/sandbox:stable\nRUN true\n`)).toBe(`ghcr.io/intentic/sandbox:stable`);
    expect(overlayBase(`RUN true\nFROM ghcr.io/intentic/sandbox:stable\n`)).toBeUndefined();
    expect(overlayBase(``)).toBeUndefined();
});

test("hasOfficialBase pins the first instruction to the official sandbox image", () => {
    expect(hasOfficialBase("FROM ghcr.io/intentic/sandbox:stable\nRUN true\n")).toBe(true);
    expect(hasOfficialBase("# comment\n\nFROM ghcr.io/intentic/sandbox:1.52.0\nRUN true\n")).toBe(true);
    expect(hasOfficialBase("FROM alpine:latest\n")).toBe(false);
    expect(hasOfficialBase("FROM ghcr.io/intentic/sandbox:\n")).toBe(false);
    expect(hasOfficialBase("RUN true\nFROM ghcr.io/intentic/sandbox:stable\n")).toBe(false);
    expect(hasOfficialBase("")).toBe(false);
});

const COMPOSED =
    `# Composed by the intentic sandbox daemon: do not edit by hand.\n\n` +
    `FROM ghcr.io/intentic/sandbox:stable\n\n` +
    `# docker capability: this directive grants dockerd the privileges it needs\n` +
    `# intentic:runtime --privileged\n\n` +
    `# ---- custom (owner-approved) ----\n` +
    `RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n` +
    `    apt-get update && apt-get install -y --no-install-recommends gnucobol\n` +
    `ENV COBOL=1\n`;

test("lintOverlay accepts a composed overlay: official FROM, runtime directive comments, RUN/ENV", () => {
    expect(lintOverlay(COMPOSED)).toBeUndefined();
});

test("lintOverlay names the line that breaks the grammar", () => {
    expect(lintOverlay(`FROM alpine:3.20\nRUN true\n`)).toBe(`FROM alpine:3.20`);
    expect(lintOverlay(`RUN true\nFROM ghcr.io/intentic/sandbox:stable\n`)).toBe(`RUN true`);
    expect(lintOverlay(`FROM ghcr.io/intentic/sandbox:stable\nCOPY . /work\n`)).toBe(`COPY . /work`);
    expect(lintOverlay(`FROM ghcr.io/intentic/sandbox:stable\nRUN true\nFROM ghcr.io/intentic/sandbox:beta\n`)).toBe(
        `FROM ghcr.io/intentic/sandbox:beta`,
    );
    expect(lintOverlay(`FROM ghcr.io/intentic/sandbox:stable\nUSER nobody\n`)).toBe(`USER nobody`);
});

test("lintOverlay refuses an overlay with nothing to build", () => {
    expect(lintOverlay(``)).toBe(``);
    expect(lintOverlay(`# only a comment\n`)).toBe(``);
});

test("rewriteOverlayBase changes the first FROM and nothing else", () => {
    const rewritten = rewriteOverlayBase(COMPOSED, `ghcr.io/intentic/sandbox:1.53.0`);
    expect(overlayBase(rewritten)).toBe(`ghcr.io/intentic/sandbox:1.53.0`);
    expect(rewritten.replace(`FROM ghcr.io/intentic/sandbox:1.53.0`, `FROM ghcr.io/intentic/sandbox:stable`)).toBe(COMPOSED);
});

test("rewriteOverlayBase leaves content alone when the first instruction is not a FROM", () => {
    expect(rewriteOverlayBase(`RUN true\n`, `ghcr.io/intentic/sandbox:stable`)).toBe(`RUN true\n`);
    expect(rewriteOverlayBase(``, `ghcr.io/intentic/sandbox:stable`)).toBe(``);
});
