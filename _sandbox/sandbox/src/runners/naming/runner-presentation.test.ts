import { memoryPresentationStore } from "../../system/presentation/presentation-store.testing.js";
import { keepRunnerPresentation, seedRunnerPresentation } from "./runner-presentation.js";

// A runner keeps the name its parent gave it, and whose it is, in the file its machine's `ic sandbox list` reads.

const IDENTITY = { id: "omen", parentUrl: "https://sandbox-x.intentic.dev" };
const AT = () => new Date("2026-11-21T10:00:00.000Z");

test("what the parent says is kept with the parent's address and name, and a repeat writes nothing", async () => {
    const store = memoryPresentationStore();
    await keepRunnerPresentation(store, IDENTITY, { name: "Gaming PC", parentName: "intentic" }, AT);
    await keepRunnerPresentation(store, IDENTITY, { name: "Gaming PC", parentName: "intentic" }, AT);
    expect(await store.read()).toEqual({
        name: "Gaming PC",
        at: "2026-11-21T10:00:00.000Z",
        runnerOf: { url: "https://sandbox-x.intentic.dev", name: "intentic" },
    });
    expect(store.writes()).toBe(1);
});

test("a new parent name is a change worth writing, though the runner's own name is the same", async () => {
    const store = memoryPresentationStore();
    await keepRunnerPresentation(store, IDENTITY, { name: "omen", parentName: "intentic" }, AT);
    await keepRunnerPresentation(store, IDENTITY, { name: "omen", parentName: "intentic (old)" }, AT);
    expect((await store.read())?.runnerOf?.name).toBe("intentic (old)");
    expect(store.writes()).toBe(2);
});

test("a first boot names the runner by its id and its parent's address", async () => {
    const store = memoryPresentationStore();
    await seedRunnerPresentation(store, IDENTITY, AT);
    expect(await store.read()).toEqual({ name: "omen", at: "2026-11-21T10:00:00.000Z", runnerOf: { url: "https://sandbox-x.intentic.dev" } });
});

test("a later boot keeps the name its parent last gave it rather than going back to the id", async () => {
    const store = memoryPresentationStore({
        name: "Gaming PC",
        at: "2026-11-20T10:00:00.000Z",
        runnerOf: { url: "https://sandbox-x.intentic.dev", name: "intentic" },
    });
    await seedRunnerPresentation(store, IDENTITY, AT);
    expect((await store.read())?.name).toBe("Gaming PC");
    expect(store.writes()).toBe(0);
});
