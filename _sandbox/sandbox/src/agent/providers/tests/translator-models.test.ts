import type { JsonFile } from "../../../store/json-file.js";
import { createCredentialModels, REFUSED_FOR_MS, type RefusedModels } from "../translator-models.js";

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

// A store held in memory, written whole on each update as the file is.
const memoryStore = (initial: RefusedModels = {}) => {
    let value = initial;
    const store: JsonFile<RefusedModels> = {
        read: async () => value,
        state: async () => ({ value, unreadable: false }),
        update: async (change) => {
            value = change(value);
            return value;
        },
    };
    return { store, written: () => value };
};

// 2026-11-20: the translator listed GPT-6.1-Terra and GPT-6 Chat Thinking for both ChatGPT Free sign-ins, which ChatGPT
// refused on every request.
const FREE = ["gpt-6-chat-thinking", "gpt-6-luna", "gpt-6.1-terra", "gpt-5.6-terra"];

test("a model the provider refused on a credential leaves that credential's list, and only that one's", async () => {
    const { read } = reader(new Map([["free", FREE], ["team", ["gpt-6.2-sol", ...FREE]]]));
    const { store, written } = memoryStore();
    const models = createCredentialModels({ read, store, now: () => 1_000 });

    await models.refused("free", "gpt-6.1-terra");
    await models.refused("free", "gpt-6-chat-thinking");

    expect(await models.of(["free", "team"])).toEqual(
        new Map([
            ["free", ["gpt-6-luna", "gpt-5.6-terra"]],
            ["team", ["gpt-6.2-sol", ...FREE]],
        ]),
    );
    // Both refusals kept, though they were filed together.
    expect(written()).toEqual({ free: { "gpt-6.1-terra": 1_000, "gpt-6-chat-thinking": 1_000 } });
});

test("a refusal kept on disk holds across a restart, and is over once REFUSED_FOR_MS has passed", async () => {
    const { read } = reader(new Map([["free", FREE]]));
    let clock = 5_000;
    const { store } = memoryStore({ free: { "gpt-6.1-terra": 5_000 } });
    const models = createCredentialModels({ read, store, now: () => clock });

    expect((await models.of(["free"])).get("free")).toEqual(["gpt-6-chat-thinking", "gpt-6-luna", "gpt-5.6-terra"]);
    clock = 5_000 + REFUSED_FOR_MS;
    expect((await models.of(["free"])).get("free")).toEqual(FREE);
});

test("a model refused on every credential that lists it is withdrawn; one another credential still runs is not", async () => {
    const { read } = reader(new Map([["free-a", FREE], ["free-b", FREE], ["team", ["gpt-6.2-sol", ...FREE]]]));
    const models = createCredentialModels({ read, now: () => 0 });
    await models.refused("free-a", "gpt-6.1-terra");
    await models.refused("free-b", "gpt-6.1-terra");

    expect(await models.withdrawn(["free-a", "free-b"])).toEqual(["gpt-6.1-terra"]);
    expect(await models.withdrawn(["free-a", "free-b", "team"])).toEqual([]);
});

test("a store that cannot be read or written leaves the refusal held in memory", async () => {
    const { read } = reader(new Map([["free", FREE]]));
    const broken: JsonFile<RefusedModels> = {
        read: async () => { throw new Error("disk"); },
        state: async () => { throw new Error("disk"); },
        update: async () => { throw new Error("disk"); },
    };
    const models = createCredentialModels({ read, store: broken, now: () => 0 });

    await models.refused("free", "gpt-6.1-terra");
    expect((await models.of(["free"])).get("free")).not.toContain("gpt-6.1-terra");
});
