import { massAbsence } from "./mass-absence.js";

test("a pass holds once five or more read gone and they are more than half of what it probed", () => {
    // The floor: four gone of four is a small board finishing together, decided exactly.
    expect(massAbsence(4, 4)).toBe(false);
    expect(massAbsence(5, 5)).toBe(true);
    // The fraction: exactly half is not a majority; one more is.
    expect(massAbsence(5, 10)).toBe(false);
    expect(massAbsence(6, 11)).toBe(true);
    expect(massAbsence(0, 0)).toBe(false);
});
