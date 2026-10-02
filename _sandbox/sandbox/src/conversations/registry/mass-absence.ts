// A sweep pass that reads most of what it probed as gone at once is one outage misread (a volume not mounted yet, a
// mount gone stale), not that many independent deletions; acting on it would archive the board or strip every
// composition. A wrongly held pass costs nothing and the next one decides again; a wrongly applied one loses the board.
// Below the floor, a few going together is ordinary and is decided exactly.
const MASS_ABSENCE_FLOOR = 5;

// Whether a pass that found `absent` of `probed` gone is inconclusive and must act on none of them.
export const massAbsence = (absent: number, probed: number): boolean => absent >= MASS_ABSENCE_FLOOR && absent * 2 > probed;
