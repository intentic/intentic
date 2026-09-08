// Pins two ways environmentVisual's brand lookup quietly fails: a name spelled differently from its product falling to
// the box, and a slug matching someone else's brand by accident.
import type { EnvironmentItem } from "@intentic/api-contract";
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
    // Three spellings one toolchain arrives under: a title-cased slug, the raw slug, and the command itself.
    expect(environmentVisual(item(`Rust tauri`, `rustc`, `cargo`)).logo).toBe(`rust`);
    expect(environmentVisual(item(`rust-tauri`)).logo).toBe(`rust`);
    expect(environmentVisual(item(`toolchain`, `rustup`)).logo).toBe(`rust`);
    expect(environmentVisual(item(`Node.js`, `node`)).logo).toBe(`nodedotjs`);
    expect(environmentVisual(item(`C++ build tools`, `g++`)).logo).toBe(`cplusplus`);
});

it(`lets the block's own name beat the commands inside it`, () => {
    // Mixing whisper-cli and g++: taking the first tool's brand would file this row under C++ instead.
    expect(environmentVisual(item(`Discord`, `whisper-cli`, `g++`, `make`)).logo).toBe(`discord`);
});

it(`tells the brandless apart by kind rather than by a shared box`, () => {
    const glyphs = [item(`ripgrep`, `rg`), item(`jq`), item(`OpenSSH`, `ssh`), item(`rsync`), item(`make`)].map(
        (entry) => environmentVisual(entry).icon,
    );
    expect(glyphs).toEqual([`search`, `code`, `key`, `arrows-h`, `wrench`]);
    expect(new Set(glyphs).size).toBe(glyphs.length);
});

it(`never lends GNU make the automation platform's mark`, () => {
    // `make` is also Make.com's slug; a wrong mark reads as fact, so it's deliberately left off the brand table.
    expect(environmentVisual(item(`make`)).logo).toBeUndefined();
});

it(`falls to the box only when neither tier recognises anything`, () => {
    // The daemon's own fallback name for a block that installs nothing probeable.
    expect(environmentVisual(item(`Custom step`))).toEqual({ icon: `box` });
});
