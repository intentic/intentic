import { createVerify, generateKeyPairSync } from "node:crypto";
import type { Config } from "../config.js";
import { createFcmForwarder, signAssertion } from "./fcm.js";

// Reaching a phone through Firebase: one access token for many sends, a data-only message that never carries the
// notification's words (a wake for the Device app, a notify for the editor app), and the same verdict split APNs gives
// the daemon (dead only when the token will never work again).

const { privateKey, publicKey } = generateKeyPairSync(`rsa`, { modulusLength: 2048 });
const account = {
    project_id: `intentic-device`,
    client_email: `relay@intentic-device.iam.gserviceaccount.com`,
    private_key: privateKey.export({ type: `pkcs8`, format: `pem` }).toString(),
    private_key_id: `key-1`,
};
const config = (serviceAccount = JSON.stringify(account)) => ({ fcm: { serviceAccount, url: `https://fcm.test` } }) as unknown as Config;
const notification = { title: `wake`, body: `this never leaves the platform`, tag: `intentic-phone-wake`, silent: true };
const device = { app: `device` } as const;
const editor = { app: `editor`, sandbox: `sbx-1` } as const;

// Google's two endpoints: the token exchange and the send, each answered as the test says.
const google = (send: { status: number; body?: unknown }) => {
    const calls: { url: string; body: string; authorization?: string }[] = [];
    const fetcher = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({
            url: String(url),
            body: String(init?.body ?? ``),
            ...(headers.get(`authorization`) === null ? {} : { authorization: headers.get(`authorization`) ?? `` }),
        });
        if (String(url).includes(`oauth2`)) {
            return Response.json({ access_token: `ya29.token`, expires_in: 3600 });
        }
        return Response.json(send.body ?? {}, { status: send.status });
    });
    return { calls, fetcher: fetcher as unknown as typeof fetch };
};

it(`signs an assertion Google can verify with the service account's public key`, () => {
    const assertion = signAssertion(account, 1_700_000_000);
    const [header, claims, signature] = assertion.split(`.`);
    const verified = createVerify(`RSA-SHA256`)
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature ?? ``, `base64url`));
    expect(verified).toBe(true);
    expect(JSON.parse(Buffer.from(claims ?? ``, `base64url`).toString())).toMatchObject({
        iss: account.client_email,
        scope: `https://www.googleapis.com/auth/firebase.messaging`,
        exp: 1_700_003_600,
    });
});

it(`sends a data-only, high-priority wake that carries none of the notification's words`, async () => {
    const { calls, fetcher } = google({ status: 200 });
    const fcm = createFcmForwarder(config(), fetcher);
    expect(await fcm.send(`fcm-1`, notification, device)).toEqual({ verdict: `delivered` });
    const sent = calls.find((entry) => entry.url.includes(`messages:send`));
    expect(sent?.url).toBe(`https://fcm.test/v1/projects/intentic-device/messages:send`);
    expect(sent?.authorization).toBe(`Bearer ya29.token`);
    expect(JSON.parse(sent?.body ?? `{}`)).toEqual({
        message: {
            token: `fcm-1`,
            data: { kind: `wake`, tag: `intentic-phone-wake` },
            android: { priority: `HIGH`, ttl: `60s`, collapse_key: `intentic-phone-wake` },
        },
    });
    expect(sent?.body).not.toContain(`never leaves`);
});

// The editor app fetches the words from the daemon itself; FCM carries only where to look and how to show it.
it(`tells the editor app what to fetch, never what the notification says`, async () => {
    const { calls, fetcher } = google({ status: 200 });
    const ask = {
        title: `Fix the login redirect: a question for you`,
        body: `Which branch should it land on?`,
        url: `/?conversation=c1`,
        tag: `awaiting-r1`,
        requireInteraction: true,
    };
    expect(await createFcmForwarder(config(), fetcher).send(`fcm-e`, ask, editor)).toEqual({ verdict: `delivered` });
    const sent = calls.find((entry) => entry.url.includes(`messages:send`));
    expect(JSON.parse(sent?.body ?? `{}`)).toEqual({
        message: {
            token: `fcm-e`,
            data: { kind: `notify`, tag: `awaiting-r1`, url: `/?conversation=c1`, sandbox: `sbx-1`, requireInteraction: `true` },
            android: { priority: `HIGH`, ttl: `21600s`, collapse_key: `awaiting-r1` },
        },
    });
    expect(sent?.body).not.toContain(`login redirect`);
    expect(sent?.body).not.toContain(`Which branch`);
});

// A withdrawn ask's replacement shows nothing new, and a high-priority message that draws no notification gets an app
// demoted by Android; one registered for no sandbox and a notification with no tag still collapse under one key.
it(`sends a silent replacement at normal priority, and leaves out what the row and notification do not have`, async () => {
    const { calls, fetcher } = google({ status: 200 });
    const fcm = createFcmForwarder(config(), fetcher);
    await fcm.send(`fcm-e`, { title: `No longer waiting`, body: `settled`, tag: `awaiting-r1`, silent: true }, editor);
    await fcm.send(`fcm-e`, { title: `intentic`, body: `untagged` }, { app: `editor`, sandbox: `` });
    const [withdrawal, untagged] = calls.filter((entry) => entry.url.includes(`messages:send`)).map((entry) => JSON.parse(entry.body).message);
    expect(withdrawal).toMatchObject({
        data: { kind: `notify`, tag: `awaiting-r1`, sandbox: `sbx-1`, silent: `true` },
        android: { priority: `NORMAL`, collapse_key: `awaiting-r1` },
    });
    expect(untagged).toEqual({
        token: `fcm-e`,
        data: { kind: `notify`, tag: `intentic` },
        android: { priority: `HIGH`, ttl: `21600s`, collapse_key: `intentic` },
    });
});

it(`mints one access token for many sends`, async () => {
    const { calls, fetcher } = google({ status: 200 });
    const fcm = createFcmForwarder(config(), fetcher);
    await fcm.send(`fcm-1`, notification, device);
    await fcm.send(`fcm-2`, notification, editor);
    expect(calls.filter((entry) => entry.url.includes(`oauth2`))).toHaveLength(1);
});

it(`calls an uninstalled app's token dead, so both halves of the channel are dropped`, async () => {
    const unregistered = google({ status: 404, body: { error: { status: `NOT_FOUND`, details: [{ errorCode: `UNREGISTERED` }] } } });
    expect(await createFcmForwarder(config(), unregistered.fetcher).send(`gone`, notification, device)).toEqual({ verdict: `dead` });
    const invalid = google({ status: 400, body: { error: { status: `INVALID_ARGUMENT`, details: [{ errorCode: `INVALID_ARGUMENT` }] } } });
    expect(await createFcmForwarder(config(), invalid.fetcher).send(`garbled`, notification, editor)).toEqual({ verdict: `dead` });
});

it(`reads Google's own trouble as transient, never as a dead phone`, async () => {
    const unavailable = google({ status: 503, body: { error: { status: `UNAVAILABLE`, details: [{ errorCode: `UNAVAILABLE` }] } } });
    expect(await createFcmForwarder(config(), unavailable.fetcher).send(`fcm-1`, notification, device)).toEqual({
        verdict: `transient`,
        reason: `FCM answered 503 UNAVAILABLE`,
    });
});

it(`is switched off without a usable service account`, async () => {
    expect(createFcmForwarder(config(``)).enabled).toBe(false);
    expect(createFcmForwarder(config(`{"not":"an account"}`)).enabled).toBe(false);
});
