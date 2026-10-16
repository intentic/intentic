import { guessLanguage } from "./voice-language.js";

/* The text's own language decides who speaks it; the reader's language only breaks a tie or fills a silence. */

test.each([
    ["Done. The login form now rejects an empty password before it calls the server.", "pl", "en"],
    ["Gotowe. Formularz logowania odrzuca teraz puste hasło, zanim wywoła serwer.", "en", "pl"],
    ["Listo. El formulario de inicio de sesión ahora rechaza una contraseña vacía.", "en", "es"],
    ["C'est fait. Le formulaire de connexion refuse maintenant un mot de passe vide.", "en", "fr"],
    ["Fertig. Das Anmeldeformular lehnt jetzt ein leeres Passwort ab, bevor es den Server aufruft.", "en", "de"],
    ["Готово. Форма входа теперь отклоняет пустой пароль.", "en", "ru"],
    ["Готово. Форма входу тепер відхиляє порожній пароль і їх.", "en", "uk"],
    ["完成了。登录表单现在会拒绝空密码。", "en", "zh"],
    ["ログインフォームは空のパスワードを拒否します。", "en", "ja"],
])("%s is %#", (text, hint, language) => {
    expect(guessLanguage(text, hint)).toBe(language);
});

test("a text too short to tell is the reader's language", () => {
    expect(guessLanguage("OK", "pl-PL")).toBe("pl");
    expect(guessLanguage("12345", "de")).toBe("de");
});

test("with no hint and nothing to go on, it is English", () => {
    expect(guessLanguage("")).toBe("en");
});
