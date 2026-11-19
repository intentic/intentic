import { createCredentialModels } from "../translator-models.js";

// What each credential's plan includes, kept between reads of the account rows: read once, handed out as held, re-read
// in the background once old, and at once when the translator turned a request away from it.

const MINUTE = 60_000;

// Lets a read started in the background land.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const reader = (lists: ReadonlyMap<string, readonly string[] | Error>) => {
    const asked: string[] = [];
    const read = async (name: string): Promise<readonly string[]> => {
        asked.push(name);
        const list = lists.get(name);
        if (list instanceof Error) {
            throw list;
        }
        return list ?? [];
    };
    return { asked, read };
};

test("a credential's list is its bare model ids, read once and then handed out as held", async () => {
    const { asked, read } = reader(new Map([["free", ["gpt-6-luna", "ic-0123456789/gpt-6-luna", "gpt-6.1-terra", "ic-0123456789/gpt-6.1-terra"]]]));
    const models = createCredentialModels({ read, now: () => 0 });

    expect(await models.of(["free"])).toEqual(new Map([["free", ["gpt-6-luna", "gpt-6.1-terra"]]]));
    expect(await models.of(["free"])).toEqual(new Map([["free", ["gpt-6-luna", "gpt-6.1-terra"]]]));
    expect(asked).toEqual(["free"]);
});

test("a list that cannot be read, or reads empty, is no list", async () => {
    const { read } = reader(new Map<string, readonly string[] | Error>([["broken", new Error("translator down")], ["empty", []]]));
    const models = createCredentialModels({ read, now: () => 0 });

    expect(await models.of(["broken", "empty"])).toEqual(new Map());
});

test("an old list is still handed out while the next is read, and the next read replaces it", async () => {
    let clock = 0;
    const lists = new Map<string, readonly string[]>([["team", ["gpt-6.2-sol"]]]);
    const { asked, read } = reader(lists);
    const models = createCredentialModels({ read, now: () => clock });
    await models.of(["team"]);

    lists.set("team", ["gpt-6.2-sol", "gpt-6.2-astra"]);
    clock = 11 * MINUTE;
    expect(await models.of(["team"])).toEqual(new Map([["team", ["gpt-6.2-sol"]]]));
    await settled();
    expect(await models.of(["team"])).toEqual(new Map([["team", ["gpt-6.2-sol", "gpt-6.2-astra"]]]));
    expect(asked).toEqual(["team", "team"]);
});

test("a recheck reads the credential again at once", async () => {
    const lists = new Map<string, readonly string[]>([["free", ["gpt-6-luna"]]]);
    const { asked, read } = reader(lists);
    const models = createCredentialModels({ read, now: () => 0 });
    await models.of(["free"]);

    lists.set("free", ["gpt-6-luna", "gpt-6.2-sol"]);
    models.recheck("free");
    await settled();
    expect(await models.of(["free"])).toEqual(new Map([["free", ["gpt-6-luna", "gpt-6.2-sol"]]]));
    expect(asked).toEqual(["free", "free"]);
});
