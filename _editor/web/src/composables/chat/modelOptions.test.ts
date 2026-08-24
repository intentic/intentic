/* WHEN A VENDOR NAMES TWO MODELS THE SAME. Cursor's catalog publishes `auto` and `auto-smart` (Cursor Router)
 * both as "Auto", which reached the picker as two identical rows: the same choice offered twice, with nothing
 * on either row saying which router a pick would run on. */
import { beforeEach, expect, it } from "vitest";
import { modelOptionsFor, perProvider, providerModels } from "./providerCatalog";

beforeEach(() => {
    providerModels.value = perProvider(() => []);
});

it(`names colliding rows by the id that distinguishes them`, () => {
    providerModels.value = {
        ...providerModels.value,
        cursor: [
            { label: `Auto`, value: `auto` },
            { label: `Auto`, value: `auto-smart` },
            { label: `Composer 2.5`, value: `composer-2.5` },
        ],
    };

    expect(modelOptionsFor(`cursor`).map((option) => option.label)).toEqual([`Auto (auto)`, `Auto (auto-smart)`, `Composer 2.5`]);
});

it(`leaves a catalog whose labels already differ exactly as its vendor wrote it`, () => {
    providerModels.value = {
        ...providerModels.value,
        claude: [
            { label: `Claude Opus 5`, value: `claude-opus-5` },
            { label: `Claude Sonnet 5`, value: `claude-sonnet-5` },
        ],
    };

    expect(modelOptionsFor(`claude`).map((option) => option.label)).toEqual([`Claude Opus 5`, `Claude Sonnet 5`]);
});
