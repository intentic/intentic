import { readFileSync } from "node:fs";
import { cardFromConfig, cardIdsFrom, selectCard, smtpOf } from "./card.js";

// The turn's environment names a card by its non-secret settings only; the backend reads the whole card from the daemon.

const env = {
    IMAP_HOST_OFFICE: "outlook.office365.com",
    IMAP_USERNAME_OFFICE: "sekretariat@urzad.example.org",
    IMAP_HOST_HOME: "imap.gmail.com",
    IMAP_USERNAME_HOME: "biuro.domowe@example.org",
};

test("cards come from the per-instance env, and several need --account", () => {
    const ids = cardIdsFrom(env);
    expect(selectCard(ids, "office")).toBe("office");
    expect(selectCard(ids, "OFFICE")).toBe("office");
    expect(() => selectCard(ids, undefined)).toThrow("--account");
    expect(() => selectCard([], undefined)).toThrow("add the IMAP card");
});

test("the card's env carries no password, refresh token, client secret or access token", () => {
    // SAFETY: the extension's own manifest, read for the one card it declares.
    const manifest = JSON.parse(readFileSync(new URL("../intentic-extension.json", import.meta.url), "utf8")) as {
        contributes: { capabilities: { fields: { key: string; secret?: boolean }[]; env: Record<string, string> }[] };
    };
    const [card] = manifest.contributes.capabilities;
    const secrets = (card?.fields ?? []).filter((field) => field.secret === true).map((field) => `\${${field.key}}`);
    expect(secrets).toEqual(["${password}", "${oauthClientSecret}", "${oauthRefreshToken}", "${accessToken}", "${smtpPassword}"]);
    expect(Object.values(card?.env ?? {}).filter((template) => secrets.some((secret) => template.includes(secret)))).toEqual([]);
});

test("a card as the daemon holds it takes its manifest's defaults for fields left at them", () => {
    expect(cardFromConfig("home", { host: "imap.gmail.com", username: "me@example.org", password: "pw" })).toMatchObject({
        port: "993",
        authMode: "password",
        oauthProvider: "microsoft",
        smtpPort: "587",
        smtpSecurity: "starttls",
    });
});

test("SMTP reuses the IMAP login, its own password when given, and the OAuth2 sign-in for both", () => {
    const home = cardFromConfig("home", { host: "imap.gmail.com", username: "biuro.domowe@example.org", password: "app-password", smtpHost: "smtp.gmail.com", smtpPassword: "smtp-only" });
    expect(smtpOf(home, { password: home.password })).toEqual({
        host: "smtp.gmail.com",
        port: 587,
        security: "starttls",
        username: "biuro.domowe@example.org",
        credential: { password: "smtp-only" },
    });
    const office = cardFromConfig("office", { host: "outlook.office365.com", username: "a@example.org", authMode: "oauth2", smtpHost: "smtp.office365.com" });
    expect(smtpOf(office, { accessToken: "at" }).credential).toEqual({ accessToken: "at" });
});
