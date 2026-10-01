import { readableProviderText } from "../provider-error-text.js";

test("a vendor's JSON error body reads as the message it carries, with its code", () => {
    expect(
        readableProviderText(
            `API Error: 404 {"error":{"code":"model_not_found","message":"The model \`glm-9\` does not exist or you do not have access to it."}}`,
        ),
    ).toBe("API Error: 404 The model `glm-9` does not exist or you do not have access to it. (model_not_found)");
    expect(readableProviderText(`{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`)).toBe("Overloaded (overloaded_error)");
    expect(readableProviderText(`{"error":"invalid api key"}`)).toBe("invalid api key");
});

test("a body with only a code still reads as words", () => {
    expect(readableProviderText(`{"error":{"code":"model_not_found"}}`)).toBe("model not found");
});

test("text with no body, or a body that says nothing, is left as it is", () => {
    expect(readableProviderText("Claude usage limit reached. Send again once it resets.")).toBe(
        "Claude usage limit reached. Send again once it resets.",
    );
    expect(readableProviderText("stopped at {step one}")).toBe("stopped at {step one}");
    expect(readableProviderText(`API Error: 500 {"ok":false}`)).toBe(`API Error: 500 {"ok":false}`);
});
