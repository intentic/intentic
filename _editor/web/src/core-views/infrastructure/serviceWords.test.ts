import { INVENTORY_SERVICES } from "@intentic/capability-catalog";
import { setLocale } from "@intentic/ui/i18n";
import { serviceDescription } from "./serviceWords";

test(`in English every service's line reads exactly as the package spells it`, () => {
    expect(INVENTORY_SERVICES.map(serviceDescription)).toEqual(INVENTORY_SERVICES.map((service) => service.description));
});

describe(`in Polish`, () => {
    beforeAll(async () => {
        await setLocale(`pl`);
    });
    afterAll(async () => {
        await setLocale(`en`);
    });

    test(`every service's line reads in Polish, and one the package has since reworded keeps its English`, () => {
        expect(INVENTORY_SERVICES.filter((service) => serviceDescription(service) === service.description).map((service) => service.service)).toEqual(
            [],
        );
        expect(serviceDescription({ service: `outline`, description: `Docs, reworded.` })).toBe(`Docs, reworded.`);
    });
});
