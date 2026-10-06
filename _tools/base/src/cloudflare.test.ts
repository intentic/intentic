import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { CloudflareError, CloudflareTokenError, CloudflareZoneFullError, cloudflareCall, cloudflarePages, ZONE_OUT_OF_RECORDS } from "./cloudflare.js";

// The one Cloudflare client the platform and the deploy engine share, against a stubbed fetch.

interface Seen {
    readonly url: string;
    readonly method: string | undefined;
    readonly headers: Record<string, string>;
    readonly body: unknown;
}

// Answers every call with the next response in line, recording what was asked.
const stubFetch = (...responses: (() => Response)[]): Seen[] => {
    const seen: Seen[] = [];
    stubGlobal(`fetch`, (url: string, init?: RequestInit): Promise<Response> => {
        seen.push({
            url,
            method: init?.method,
            headers: Object.fromEntries(new Headers(init?.headers)),
            body: init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body)),
        });
        const next = responses[Math.min(seen.length - 1, responses.length - 1)];
        if (next === undefined) {
            throw new Error(`unexpected fetch: ${url}`);
        }
        return Promise.resolve(next());
    });
    return seen;
};

const envelope = (result: unknown, extra: Record<string, unknown> = {}) => () =>
    new Response(JSON.stringify({ success: true, errors: [], result, ...extra }));

const refused = (status: number, ...errors: { code: number; message: string }[]) => () =>
    new Response(JSON.stringify({ success: false, errors, result: null }), { status });

afterEach(() => {
    unstubAllGlobals();
});

it(`sends the token as a bearer, a body as JSON, and hands back the envelope's result`, async () => {
    const seen = stubFetch(envelope({ id: `tunnel-1` }));
    await expect(cloudflareCall(`tok`, `/accounts/a/cfd_tunnel`, { method: `POST`, body: { name: `x` } })).resolves.toEqual({ id: `tunnel-1` });
    expect(seen).toEqual([
        {
            url: `https://api.cloudflare.com/client/v4/accounts/a/cfd_tunnel`,
            method: `POST`,
            headers: { authorization: `Bearer tok`, "content-type": `application/json` },
            body: { name: `x` },
        },
    ]);
});

it(`sends no content type, method or body on a plain read`, async () => {
    const seen = stubFetch(envelope([]));
    await cloudflareCall(`tok`, `/zones?name=example.com`);
    expect(seen[0]).toEqual({
        url: `https://api.cloudflare.com/client/v4/zones?name=example.com`,
        method: undefined,
        headers: { authorization: `Bearer tok` },
        body: undefined,
    });
});

it(`reads a 401 or 403 as the token's fault, with or without an envelope behind it`, async () => {
    stubFetch(() => new Response(``, { status: 403 }));
    const bare = await cloudflareCall(`bad`, `/zones`).catch((error: unknown) => error);
    expect(bare).toBeInstanceOf(CloudflareTokenError);
    expect(bare).toMatchObject({ status: 403, codes: [] });

    unstubAllGlobals();
    stubFetch(refused(401, { code: 9109, message: `Invalid access token` }));
    const said = await cloudflareCall(`bad`, `/zones`).catch((error: unknown) => error);
    expect(said).toBeInstanceOf(CloudflareTokenError);
    expect(said).toMatchObject({ message: `Cloudflare API GET /zones was refused (HTTP 401): 9109 Invalid access token`, codes: [9109] });
});

it(`tells a zone out of DNS records from any other refusal, by its code`, async () => {
    stubFetch(refused(400, { code: ZONE_OUT_OF_RECORDS, message: `Record quota exceeded.` }));
    const full = await cloudflareCall(`tok`, `/zones/z/dns_records`, { method: `POST`, body: {} }).catch((error: unknown) => error);
    expect(full).toBeInstanceOf(CloudflareZoneFullError);
    expect(full).toMatchObject({ status: 400, codes: [81_045] });

    unstubAllGlobals();
    stubFetch(refused(400, { code: 1003, message: `invalid zone` }));
    const other = await cloudflareCall(`tok`, `/zones/z`).catch((error: unknown) => error);
    expect(other).toBeInstanceOf(CloudflareError);
    expect(other).not.toBeInstanceOf(CloudflareZoneFullError);
    expect(other).toMatchObject({ message: `Cloudflare API GET /zones/z failed (HTTP 400): 1003 invalid zone` });
});

it(`refuses a success:false envelope even on a 200`, async () => {
    stubFetch(refused(200, { code: 7003, message: `Could not route` }));
    await expect(cloudflareCall(`tok`, `/x`)).rejects.toThrow(`Cloudflare API GET /x failed (HTTP 200): 7003 Could not route`);
});

it(`refuses an answer that is not Cloudflare's envelope`, async () => {
    stubFetch(() => new Response(JSON.stringify({ hello: `world` })));
    await expect(cloudflareCall(`tok`, `/x`)).rejects.toThrow(`Cloudflare API GET /x returned an unexpected response: not Cloudflare's envelope (HTTP 200)`);
});

it(`says how long a call took when the network failed it`, async () => {
    stubGlobal(`fetch`, () => Promise.reject(new Error(`ECONNRESET`)));
    await expect(cloudflareCall(`tok`, `/x`)).rejects.toThrow(/^Cloudflare API GET \/x transport failed after \d+ms: ECONNRESET$/);
});

it(`walks every page a list reports, and stops at one when it reports none`, async () => {
    const seen = stubFetch(envelope([{ name: `one.com` }], { result_info: { total_pages: 2 } }), envelope([{ name: `two.com` }], { result_info: { total_pages: 2 } }));
    await expect(cloudflarePages(`tok`, `/zones`)).resolves.toEqual([{ name: `one.com` }, { name: `two.com` }]);
    expect(seen.map((call) => call.url)).toEqual([
        `https://api.cloudflare.com/client/v4/zones?per_page=50&page=1`,
        `https://api.cloudflare.com/client/v4/zones?per_page=50&page=2`,
    ]);

    unstubAllGlobals();
    const once = stubFetch(envelope([{ name: `only.com` }], { result_info: { count: 1 } }));
    await expect(cloudflarePages(`tok`, `/zones?name=only.com`, 10)).resolves.toEqual([{ name: `only.com` }]);
    expect(once.map((call) => call.url)).toEqual([`https://api.cloudflare.com/client/v4/zones?name=only.com&per_page=10&page=1`]);
});
