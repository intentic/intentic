// WHAT THE LIST LOOKED LIKE BEFORE: eighteen entries, eighteen identical grey boxes, so telling ffmpeg from Bun
// meant reading the column rather than glancing at it. What is pinned here is the two ways a mark table quietly
// stops earning that back: a block whose name is spelled differently from its product falling through to the
// box, and a slug that resolves to somebody ELSE's brand being honoured because it happened to exist.
import type { EnvironmentItem } from "@intentic-app/api-contract";
import { expect, it } from "vitest";
import { environmentVisual } from "./environmentVisual";

const item = (name: string, ...tools: string[]): EnvironmentItem => ({
    id: `custom:${name}`,
    name,
    origin: `custom`,
    state: `active`,
    tools: tools.map((tool) => ({ name: tool })),
});

it(`reaches a product's mark however the block that installs it was named`, () => {
    // The three spellings one toolchain arrives under: the daemon's title-cased slug, the raw slug, and the
    // command itself. A table keyed on whole names would have matched none of them.
    expect(environmentVisual(item(`Rust tauri`, `rustc`, `cargo`)).logo).toBe(`rust`);
    expect(environmentVisual(item(`rust-tauri`)).logo).toBe(`rust`);
    expect(environmentVisual(item(`toolchain`, `rustup`)).logo).toBe(`rust`);
    // And the same for a name carrying punctuation of its own.
    expect(environmentVisual(item(`Node.js`, `node`)).logo).toBe(`nodedotjs`);
    expect(environmentVisual(item(`C++ build tools`, `g++`)).logo).toBe(`cplusplus`);
});

it(`lets the block's own name beat the commands inside it`, () => {
    // The discord capability installs whisper.cpp and a compiler. Taking the first tool's brand would file it
    // under C++: the row would be correct about its contents and useless for finding the capability.
    expect(environmentVisual(item(`Discord`, `whisper-cli`, `g++`, `make`)).logo).toBe(`discord`);
});

it(`tells the brandless apart by kind rather than by a shared box`, () => {
    // The five entries with no brand in the set. If these collapsed onto one glyph, a quarter of the list would
    // be exactly as unscannable as it was.
    const glyphs = [item(`ripgrep`, `rg`), item(`jq`), item(`OpenSSH`, `ssh`), item(`rsync`), item(`make`)].map(
        (entry) => environmentVisual(entry).icon,
    );
    expect(glyphs).toEqual([`search`, `code`, `key`, `arrows-h`, `wrench`]);
    expect(new Set(glyphs).size).toBe(glyphs.length);
});

it(`never lends GNU make the automation platform's mark`, () => {
    // `make` IS a slug in that set: Make.com's purple M. A wrong mark reads as a fact, where the glyph reads as
    // "no brand for this one", so the entry is deliberately left off the brand table.
    expect(environmentVisual(item(`make`)).logo).toBeUndefined();
});

it(`falls to the box only when neither tier recognises anything`, () => {
    // The daemon's own fallback name for a block that installs nothing probeable.
    expect(environmentVisual(item(`Custom step`))).toEqual({ icon: `box` });
});
