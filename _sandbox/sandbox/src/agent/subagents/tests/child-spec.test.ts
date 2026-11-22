import { childOpening } from "../child-spec.js";

test("a child's opening turn carries its checkout scope to the conversation identity", () => {
    expect(childOpening({ prompt: "read files", provider: "claude", model: "opus", paths: ["FIRMA/KADRY"] }, "move")).toMatchObject({
        checkoutPaths: ["FIRMA/KADRY"],
    });
});
