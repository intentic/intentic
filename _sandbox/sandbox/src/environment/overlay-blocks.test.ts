import { expect, test } from "vitest";
import { blockCommands, blockProse, blockTools, detailOf, purposeOf, splitBlocks } from "./overlay-blocks.js";
import { parseVersion } from "./version-probe.js";

// The real shape of a custom-section block, wrapped and continued exactly as the daemon writes one.
const FFMPEG = `# ---- ffmpeg ----
# ffmpeg — encoding screen recordings (Playwright records VP8/WebM; its bundled ffmpeg cannot encode H.264,
# so a promo/demo capture can't be handed over as an editable MP4 without this).
RUN apt-get update \\
    && apt-get install -y --no-install-recommends ffmpeg \\
    && rm -rf /var/lib/apt/lists/*`;

const RUST = `# ---- rust-tauri ----
# The desktop app is a Tauri 2 shell, so its whole native half is Rust that nothing in this image can compile.
#
# Three groups, and each is needed for a different reason:
#   • build-essential / pkg-config / libssl-dev — what any crate with a C dependency needs to link at all.
#   • clang / lld — cargo-xwin's cross-link toolchain.
RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
        build-essential \\
        pkg-config \\
        libssl-dev \\
        patchelf \\
        clang \\
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \\
    && rustc --version \\
    && cargo --version`;

test("splits the custom section into the blocks the agent named", () => {
    const blocks = splitBlocks(`${FFMPEG}\n\n${RUST}`);
    expect(blocks.map((block) => block.name)).toEqual([`ffmpeg`, `rust-tauri`]);
    expect(blocks[0]?.body).toContain(`apt-get install -y --no-install-recommends ffmpeg`);
});

test("keeps content that arrived before any marker rather than dropping it", () => {
    const blocks = splitBlocks(`RUN echo unnamed\n\n${FFMPEG}`);
    expect(blocks.map((block) => block.name)).toEqual([``, `ffmpeg`]);
});

test("unwraps the leading comment into paragraphs and keeps its bullets on their own lines", () => {
    const prose = blockProse(splitBlocks(RUST)[0]?.body ?? ``);
    const [intro, groups] = prose.split(`\n\n`);
    expect(intro).toBe(`The desktop app is a Tauri 2 shell, so its whole native half is Rust that nothing in this image can compile.`);
    expect(groups?.split(`\n`)).toHaveLength(3);
});

test("stops at the first instruction, so comments annotating a command are not read as the explanation", () => {
    expect(blockProse(`# what it is for\nRUN one\n# why this line is odd\nRUN two`)).toBe(`what it is for`);
});

test("the row's line is the first sentence, with the trailing qualification dropped", () => {
    expect(purposeOf(blockProse(splitBlocks(FFMPEG)[0]?.body ?? ``))).toBe(`ffmpeg — encoding screen recordings.`);
});

test("a full stop inside a version, a filename or an abbreviation does not end the sentence", () => {
    expect(purposeOf(`Pinned to v1.9.1 so the build is reproducible. The rest is detail.`)).toBe(`Pinned to v1.9.1 so the build is reproducible.`);
    expect(purposeOf(`Needed by anything native, e.g. node-pty. More follows.`)).toBe(`Needed by anything native, e.g. node-pty.`);
});

test("a short sentence keeps its parenthetical — removing it would leave nothing worth reading", () => {
    expect(purposeOf(`Bun (a runtime).`)).toBe(`Bun (a runtime).`);
});

test("an over-long opening sentence is cut back to the clause that makes the claim", () => {
    const sentence =
        `The desktop app (_apps/desktop) is a Tauri 2 shell, so its whole native half is Rust that nothing in this image can compile: ` +
        `there is no cargo, no pkg-config, and no webview headers.`;
    expect(purposeOf(sentence)).toBe(
        `The desktop app (_apps/desktop) is a Tauri 2 shell, so its whole native half is Rust that nothing in this image can compile.`,
    );
});

test("a long sentence with no clause break is left whole rather than butchered", () => {
    const long = `${`a`.repeat(200)}.`;
    expect(purposeOf(long)).toBe(long);
});

/* The disclosure is the prose WHOLE, not the prose minus the row's line. Slicing the line off only works while
 * the two are cut at the same place, and they are not — the row's line drops a trailing parenthetical and cuts
 * an over-long sentence back to its claim — so the remainder still opened with the sentence the row was showing
 * and the view printed it twice. */
test("the disclosure is the whole explanation, so the row's summary is never printed twice", () => {
    const prose = `ffmpeg — encoding screen recordings (Playwright records VP8/WebM). More detail follows.`;
    expect(detailOf(prose, `ffmpeg — encoding screen recordings.`)).toBe(prose);
    expect(detailOf(`It does the thing. And here is why that was necessary.`, `It does the thing.`)).toBe(
        `It does the thing. And here is why that was necessary.`,
    );
});

test("nothing beyond the row's line means nothing to disclose", () => {
    expect(detailOf(`It does the thing.`, `It does the thing.`)).toBeUndefined();
    expect(detailOf(``, undefined)).toBeUndefined();
});

/* A capability fragment is written for the Dockerfile it lands in, where naming its own source is the only
 * provenance there is and a runtime marker has nowhere else to live. In this view the row is already titled
 * `docker`, already grouped under the capabilities and already attributed, so both come off. */
test("prose drops the source the row already names, and the directives addressed to the rebuilder", () => {
    const fragment = `# docker capability: this directive grants dockerd the privileges it needs
# (translated to a --privileged run by the allowlisted rebuild executors).
# intentic:runtime --privileged`;
    expect(blockProse(fragment, `docker capability`)).toBe(
        `This directive grants dockerd the privileges it needs (translated to a --privileged run by the allowlisted rebuild executors).`,
    );
    // Nothing is stripped on a hunch: the same words, with no label that matches them, are somebody's sentence.
    expect(blockProse(`# WebKitGTK: the webview Tauri draws into on Linux.`, `rust capability`)).toBe(
        `WebKitGTK: the webview Tauri draws into on Linux.`,
    );
});

test("commands are everything below the explanation", () => {
    const commands = blockCommands(splitBlocks(FFMPEG)[0]?.body ?? ``);
    expect(commands.startsWith(`RUN apt-get update`)).toBe(true);
    expect(commands).not.toContain(`encoding screen recordings`);
});

test("finds the commands a block verifies itself with, across line continuations", () => {
    const { candidates } = blockTools(splitBlocks(RUST)[0] ?? { name: ``, body: `` });
    expect(candidates.slice(0, 2)).toEqual([`rustc`, `cargo`]);
    // The apt list is reached through the continuation, and the block's own name is a candidate of last resort.
    expect(candidates).toContain(`clang`);
    expect(candidates).toContain(`patchelf`);
});

test("counts every package the block installs, so what is not a command can be summarised", () => {
    const { packages } = blockTools(splitBlocks(RUST)[0] ?? { name: ``, body: `` });
    expect(packages).toEqual([`build-essential`, `pkg-config`, `libssl-dev`, `patchelf`, `clang`]);
    // The cleanup half of the same RUN contributes nothing.
    expect(packages).not.toContain(`rm`);
});

test("a single-package block is named by its own package", () => {
    expect(blockTools(splitBlocks(FFMPEG)[0] ?? { name: ``, body: `` }).candidates).toEqual([`ffmpeg`]);
});

test("finds a binary installed straight into a bin directory, and a global npm package's command", () => {
    expect(blockTools({ name: `whisper`, body: `RUN install /tmp/build/whisper-cli /usr/local/bin/whisper-cli` }).candidates).toContain(
        `whisper-cli`,
    );
    expect(blockTools({ name: `codex`, body: `RUN npm install -g @openai/codex@0.147.0` }).candidates).toContain(`codex`);
});

test("reads the version out of whatever shape a tool prints it in", () => {
    expect(parseVersion(`rustc 1.90.0 (1159e78c4 2026-05-12)`)).toBe(`1.90.0`);
    expect(parseVersion(`ffmpeg version 6.1.1-3ubuntu5 Copyright (c)`)).toBe(`6.1.1`);
    expect(parseVersion(`Docker version 27.3.1, build ce1223035a`)).toBe(`27.3.1`);
    expect(parseVersion(`1.2.4`)).toBe(`1.2.4`);
    expect(parseVersion(`no numbers here`)).toBeUndefined();
});
