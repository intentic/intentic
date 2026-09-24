import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "./scenario.js";

// Found by listing, as the CLI finds them, so a scenario added without a test is still run here.
const scenarios = await Promise.all(
    readdirSync(join(import.meta.dir, "scenarios")).map(async (file) => {
        const name = file.replace(/\.ts$/u, "");
        return [name, ((await import(`./scenarios/${name}.js`)) as { scenario: Scenario }).scenario] as const;
    }),
);

describe("every instruction-count scenario", () => {
    it.each(scenarios)("%s builds its input and its work passes its own check", async (_name, scenario) => {
        const work = await scenario.setup();
        expect(await work()).toEqual(expect.anything());
    });
});
