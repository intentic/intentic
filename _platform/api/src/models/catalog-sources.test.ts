import { catalogSources, discoverBrowsingModels } from "./catalog-sources.js";

const source = () => catalogSources(JSON.stringify([{
    provider: `claude`, format: `anthropic`, url: `https://models.example/v1/models`, include: `^claude-`,
    headers: { authorization: `Bearer service-account`, "anthropic-version": `2023-06-01` },
}]))[0]!;

test(`reads every upstream page, forwards service headers, and publishes only model IDs and names`, async () => {
    const fetcher = jest.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ data: [{ id: `claude-opus-12`, display_name: `Claude Opus 12`, private: `never publish` }], has_more: true, last_id: `cursor-1` }))
        .mockResolvedValueOnce(Response.json({ data: [{ id: `embedding-1` }, { id: `claude-sonnet-12`, display_name: `Claude Sonnet 12` }] }));
    expect(await discoverBrowsingModels(source(), fetcher)).toEqual([
        { id: `claude-opus-12`, label: `Claude Opus 12` }, { id: `claude-sonnet-12`, label: `Claude Sonnet 12` },
    ]);
    expect(String(fetcher.mock.calls[1]![0])).toBe(`https://models.example/v1/models?after_id=cursor-1`);
    expect(fetcher.mock.calls[0]![1]?.headers).toEqual(source().headers);
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe(`error`);
});

test(`a failed page, empty result or unreadable catalog cannot replace the previous successful discovery`, async () => {
    for (const response of [new Response(`private`, { status: 401 }), Response.json({ data: [] }), Response.json({ wrong: [] })]) {
        await expect(discoverBrowsingModels(source(), jest.fn(async () => response))).rejects.toThrow();
    }
    const stuck = jest.fn(async () => Response.json({ data: [{ id: `claude-opus-12` }], has_more: true, last_id: `same` }));
    await expect(discoverBrowsingModels(source(), stuck)).rejects.toThrow(`did not advance pagination`);
});

test(`unordered OpenAI catalogs order numeric releases without a list of known versions`, async () => {
    const fetcher = jest.fn(async () => Response.json({ data: [{ id: `gpt-9` }, { id: `gpt-12` }, { id: `gpt-12.1` }] }));
    expect((await discoverBrowsingModels({ ...source(), provider: `codex`, format: `openai`, include: `^gpt-` }, fetcher)).map((row) => row.id))
        .toEqual([`gpt-12.1`, `gpt-12`, `gpt-9`]);
});

test(`a published integration catalog is supported and configuration rejects duplicate integrations or broken filters`, async () => {
    const fetcher = jest.fn(async () => Response.json({ models: [{ id: `claude-newfamily-1`, label: `New family 1`, apiKey: `never publish` }] }));
    expect(await discoverBrowsingModels({ ...source(), format: `catalog` }, fetcher)).toEqual([{ id: `claude-newfamily-1`, label: `New family 1` }]);
    expect(() => catalogSources(JSON.stringify([source(), source()]))).toThrow(`only one catalog source`);
    expect(() => catalogSources(JSON.stringify([{ ...source(), include: `[` }]))).toThrow();
});

test(`malformed configuration never echoes service credentials in a parser error`, () => {
    expect(() => catalogSources(`{"headers":{"authorization":"private-service-token"} broken}`))
        .toThrow(new Error(`MODEL_CATALOG_SOURCES must contain valid JSON`));
});
