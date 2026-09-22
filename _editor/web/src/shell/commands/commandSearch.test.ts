import { it, expect } from "bun:test";
import { nameScore, rankCommands } from "./commandSearch";
import type { RegisteredCommand } from "./useCommands";

// Pins what a typed query finds: word order must not matter, the name must beat the id, and an empty query must be the
// whole registry in an order families survive.

const command = (id: string, title: string, category?: string): RegisteredCommand =>
    ({ owner: `builtin`, command: id, title, category, gate: undefined, handler: () => undefined }) as RegisteredCommand;

const REGISTRY: readonly RegisteredCommand[] = [
    command(`view.sandbox.secrets`, `Secrets`, `Sandbox`),
    command(`view.settings.keybindings`, `Keybindings`, `Settings`),
    command(`terminal.new`, `New Terminal`, `Terminal`),
    command(`terminal.killAll`, `Kill All`, `Terminal`),
    command(`workspace.commandPalette`, `Command Palette…`),
];

const found = (query: string): readonly string[] => rankCommands(REGISTRY, query).map((entry) => entry.command);

it(`matches every term in any order, across the family and the name`, () => {
    expect(found(`sandbox secrets`)).toEqual([`view.sandbox.secrets`]);
    expect(found(`secrets sandbox`)).toEqual([`view.sandbox.secrets`]);
});

it(`finds a command by its id, for the reader who knows the id`, () => {
    expect(found(`view.settings`)).toEqual([`view.settings.keybindings`]);
});

it(`ranks the name someone typed the start of above a match in the middle of a word`, () => {
    // Both match — a lone "n" is inside "Terminal" as well — but only one name begins with what was typed.
    expect(found(`terminal n`)).toEqual([`terminal.new`, `terminal.killAll`]);
    // Both names begin with the family, which ranks neither: the rest of the name decides, alphabetically.
    expect(found(`terminal`)).toEqual([`terminal.killAll`, `terminal.new`]);
});

it(`answers nothing when a term appears in no command`, () => {
    expect(found(`sandbox keybindings`)).toEqual([]);
});

it(`reads an empty query as the whole registry: destinations first, then alphabetically, so families sit together`, () => {
    // Destinations lead because a palette opened to be read is a menu of places — and because the row a bare Enter
    // lands on is then a navigation, never something that acts.
    expect(found(``)).toEqual([`view.sandbox.secrets`, `view.settings.keybindings`, `workspace.commandPalette`, `terminal.killAll`, `terminal.new`]);
});

it(`scores a family-only match, so typing a family lists all of it`, () => {
    expect(nameScore(`Sandbox: Secrets`, `view.sandbox.secrets`, `sandbox`)).toBeGreaterThan(0);
    expect(nameScore(`Sandbox: Secrets`, `view.sandbox.secrets`, `personas`)).toBeUndefined();
});

// The palette lists four kinds of row at once and orders the kinds against each other by their best score, so every
// tier has to answer on the same 0..1 axis a path scores on. A tier above 1 would let one kind outrank another by
// arithmetic rather than by evidence.
it(`scores name matches between zero and one, the axis paths are scored on`, () => {
    const scores = [`Sandbox: Secrets`, `sandbox`, `secrets`, `view.sandbox`].map((query) =>
        nameScore(`Sandbox: Secrets`, `view.sandbox.secrets`, query),
    );
    expect(scores).toEqual([0.95, 0.95, 0.8, 0.3]);
});
