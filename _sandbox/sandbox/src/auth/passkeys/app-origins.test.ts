import { apkKeyHashOrigin, AssetLinksSchema, appOriginsOf, createAppRelyingParty } from "./app-origins.js";

/* Which native apps may sign in with the editor's passkeys is the editor's own Digital Asset Links file, read the way
 * Android reads it: only a `get_login_creds` grant to an Android app admits that app's signing certificate, and it signs
 * for the editor's rpId. */

// 0x00..0x1f and 0x20..0x3f as keytool prints them, and the origins Credential Manager writes for apps signed with them.
const PLAY = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0").toUpperCase()).join(":");
const UPLOAD = Array.from({ length: 32 }, (_, index) => (index + 32).toString(16).padStart(2, "0")).join(":");
const PLAY_ORIGIN = "android:apk-key-hash:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const UPLOAD_ORIGIN = apkKeyHashOrigin(UPLOAD);
const STRANGER_ORIGIN = apkKeyHashOrigin(Array.from({ length: 32 }, () => "EE").join(":"));

const statements = [
    {
        relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
        target: { namespace: "android_app", package_name: "dev.intentic.app", sha256_cert_fingerprints: [PLAY, UPLOAD, "not a fingerprint"] },
    },
    // App Links alone open links; they sign nobody in.
    {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "dev.intentic.device", sha256_cert_fingerprints: [Array.from({ length: 32 }, () => "EE").join(":")] },
    },
    { relation: ["delegate_permission/common.get_login_creds"], target: { namespace: "web", site: "https://app.example.test" } },
    { include: "https://elsewhere.example.test/.well-known/assetlinks.json" },
];

const silent = { warn: jest.fn() };

// The editor's host answering the file as the test says, counting the reads.
const editorHost = (answer: () => Response | Promise<Response>) => {
    const asked: { readonly url: string; readonly redirect: RequestRedirect | undefined }[] = [];
    const answering = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        asked.push({ url: String(url), redirect: init?.redirect });
        return answer();
    };
    const fetcher = Object.assign(answering, { preconnect: globalThis.fetch.preconnect });
    return { asked, fetcher };
};

test("a certificate's origin is the base64url of its SHA-256, exactly as Credential Manager writes it", () => {
    expect(apkKeyHashOrigin(PLAY)).toBe(PLAY_ORIGIN);
    expect(apkKeyHashOrigin(PLAY.toLowerCase())).toBe(PLAY_ORIGIN);
});

test("only a get_login_creds grant to an Android app admits its well-formed fingerprints", () => {
    expect([...appOriginsOf(AssetLinksSchema.parse(statements))]).toEqual([PLAY_ORIGIN, UPLOAD_ORIGIN]);
    expect(AssetLinksSchema.safeParse({ not: "a list" }).success).toBe(false);
});

test("an admitted app signs for the editor's rpId; a stranger's certificate and a web origin sign for nothing", async () => {
    const { asked, fetcher } = editorHost(() => Response.json(statements));
    const appRelyingParty = createAppRelyingParty({ webOrigin: "https://*.preview.example.test, https://app.example.test", logger: silent, fetcher });
    expect(await appRelyingParty(PLAY_ORIGIN)).toBe("app.example.test");
    expect(await appRelyingParty(UPLOAD_ORIGIN)).toBe("app.example.test");
    expect(await appRelyingParty(STRANGER_ORIGIN)).toBeUndefined();
    expect(await appRelyingParty("https://app.example.test")).toBeUndefined();
    // The first exact https editor's own file, read once for all of them, and never through a redirect.
    expect(asked).toEqual([{ url: "https://app.example.test/.well-known/assetlinks.json", redirect: "error" }]);
});

test("the statement is read again after ten minutes, and an outage keeps the last one read", async () => {
    const clock = { now: 0 };
    const answers: (() => Response)[] = [() => Response.json(statements), () => new Response("down", { status: 503 }), () => Response.json([])];
    const { asked, fetcher } = editorHost(() => (answers.shift() ?? (() => Response.json([])))());
    const logger = { warn: jest.fn() };
    const appRelyingParty = createAppRelyingParty({ webOrigin: "https://app.example.test", logger, fetcher, now: () => clock.now });

    expect(await appRelyingParty(PLAY_ORIGIN)).toBe("app.example.test");
    clock.now += 9 * 60_000;
    expect(await appRelyingParty(PLAY_ORIGIN)).toBe("app.example.test");
    expect(asked).toHaveLength(1);

    // Read again, and the editor is down: the last statement stands, and the failure is said.
    clock.now += 2 * 60_000;
    expect(await appRelyingParty(PLAY_ORIGIN)).toBe("app.example.test");
    expect(asked).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // A fingerprint the editor withdraws stops signing in on the next read.
    clock.now += 31_000;
    expect(await appRelyingParty(PLAY_ORIGIN)).toBeUndefined();
    expect(asked).toHaveLength(3);
});

test("a sandbox whose editor has no exact https origin admits no app, and asks nobody", async () => {
    const { asked, fetcher } = editorHost(() => Response.json(statements));
    for (const webOrigin of ["http://localhost:5173", "https://*.example.test"]) {
        expect(await createAppRelyingParty({ webOrigin, logger: silent, fetcher })(PLAY_ORIGIN)).toBeUndefined();
    }
    expect(asked).toEqual([]);
});
