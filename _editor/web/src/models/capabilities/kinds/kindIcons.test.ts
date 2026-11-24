import { CapabilityKindSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { KIND_ICONS, kindIcon } from "./kindIcons";

test(`every kind has a glyph, and one this build does not know is the bolt`, () => {
    expect(Object.keys(KIND_ICONS)).toEqual(CapabilityKindSchema.options);
    expect(kindIcon(`webext`)).toBe(`globe`);
    expect(kindIcon(`device`)).toBe(`desktop`);
    expect(kindIcon(`phone`)).toBe(`mobile`);
    expect(kindIcon(`a-newer-kind`)).toBe(`bolt`);
    expect(kindIcon(`toString`)).toBe(`bolt`);
});
