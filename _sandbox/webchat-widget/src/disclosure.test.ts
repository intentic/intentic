import type { WebchatPublicConfig } from "@intentic/sandbox-contract";
import { VisitorChatElement, disclosureText } from "./element.js";

const config = (extra: Partial<WebchatPublicConfig> = {}): WebchatPublicConfig => ({
    automationId: "notice-test", title: "Ask", greeting: "Hello", accent: "#e47100", position: "bottom-right",
    access: "public", requireName: false, antiBot: "off", aiDisclosure: true, ...extra,
});

const render = (extra: Partial<WebchatPublicConfig> = {}): VisitorChatElement => {
    if (customElements.get("notice-test-chat") === undefined) {
        customElements.define("notice-test-chat", VisitorChatElement);
    }
    const element = document.createElement("notice-test-chat") as VisitorChatElement;
    element.configure(config(extra), { base: "https://example.invalid", automationId: "notice-test" });
    document.body.append(element);
    return element;
};

afterEach(() => document.querySelector("notice-test-chat")?.remove());

test("the panel shows an AI disclosure by default", () => {
    const line = render().shadowRoot?.querySelector(".ai-disclosure");
    expect(line?.textContent).toBe("Replies are written by an AI assistant and may contain mistakes.");
});

test("an explicit opt out hides the disclosure", () => {
    expect(render({ aiDisclosure: false }).shadowRoot?.querySelector(".ai-disclosure")).toBeNull();
});

test("custom wording is escaped and shown", () => {
    const line = render({ aiDisclosureText: "<Check this>" }).shadowRoot?.querySelector(".ai-disclosure");
    expect(line?.textContent).toBe("<Check this>");
    expect(line?.querySelector("check")).toBeNull();
});

test("built-in disclosure follows the visitor's browser language", () => {
    expect(disclosureText(config(), "pl-PL")).toBe("Odpowiedzi pisze asystent AI. Mogą zawierać błędy.");
    expect(disclosureText(config(), "de-DE")).toBe("Die Antworten stammen von einem KI-Assistenten und können Fehler enthalten.");
    expect(disclosureText(config(), "fr-FR")).toBe("Les réponses sont rédigées par un assistant IA et peuvent contenir des erreurs.");
    expect(disclosureText(config(), "es-ES")).toBe("Las respuestas las escribe un asistente de IA y pueden contener errores.");
    expect(disclosureText(config(), "xx-XX")).toBe("Replies are written by an AI assistant and may contain mistakes.");
});
