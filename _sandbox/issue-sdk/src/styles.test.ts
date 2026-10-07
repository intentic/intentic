import { DEFAULT_ACCENT } from "@intentic/sandbox-contract/embed";
import { dialogStyles } from "./styles.js";

// The Send button is the dialog's one solid accent; its label has to be readable on whatever accent the owner picked.

test("the default orange gets the dark label, which passes AA where white at 3.15:1 does not", () => {
    expect(dialogStyles(DEFAULT_ACCENT)).toContain("button.send { background: #e47100; color: #111827; }");
    expect(dialogStyles("#1a3d8f")).toContain("button.send { background: #1a3d8f; color: #ffffff; }");
});

test("an accent the maths cannot read paints as the default orange, not as a broken rule", () => {
    const sheet = dialogStyles("rebeccapurple");
    expect(sheet).toContain("button.send { background: #e47100; color: #111827; }");
    expect(sheet).toContain("rgba(228, 113, 0, 0.22)");
    expect(sheet).not.toContain("rebeccapurple");
});
