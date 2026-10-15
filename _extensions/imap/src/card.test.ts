import { cardsFrom, selectCard, smtpOf } from "./card.js";

const env = {
    IMAP_HOST_OFFICE: "outlook.office365.com",
    IMAP_USERNAME_OFFICE: "sekretariat@urzad.example.org",
    IMAP_AUTH_MODE_OFFICE: "oauth2",
    IMAP_OAUTH_PROVIDER_OFFICE: "microsoft",
    SMTP_HOST_OFFICE: "smtp.office365.com",
    IMAP_HOST_HOME: "imap.gmail.com",
    IMAP_USERNAME_HOME: "biuro.domowe@example.org",
    IMAP_PASSWORD_HOME: "app-password",
    SMTP_HOST_HOME: "smtp.gmail.com",
    SMTP_PASSWORD_HOME: "smtp-only",
};

test("cards come from the per-instance env, and several need --account", () => {
    const cards = cardsFrom(env);
    expect(selectCard(cards, "office")).toMatchObject({ host: "outlook.office365.com", port: "993", authMode: "oauth2", oauthProvider: "microsoft" });
    expect(() => selectCard(cards, undefined)).toThrow("--account");
    expect(() => selectCard([], undefined)).toThrow("add the IMAP card");
});

test("SMTP reuses the IMAP login, its own password when given, and the OAuth2 sign-in for both", () => {
    const cards = cardsFrom(env);
    const home = selectCard(cards, "home");
    expect(smtpOf(home, { password: home.password })).toEqual({
        host: "smtp.gmail.com",
        port: 587,
        security: "starttls",
        username: "biuro.domowe@example.org",
        credential: { password: "smtp-only" },
    });
    const office = selectCard(cards, "office");
    expect(smtpOf(office, { accessToken: "at" }).credential).toEqual({ accessToken: "at" });
});
