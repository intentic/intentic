/* WHEN A VENDOR NAMES TWO MODELS THE SAME. */
import { modelOptionsFor, perProvider, providerModels } from "../../../models/providers/providerCatalog";

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
