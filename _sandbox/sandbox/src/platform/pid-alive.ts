/* IS THAT PROCESS STILL THERE, the one question every claim in this container turns on.
 *
 * Signal 0 delivers nothing and only asks whether the pid is there to receive it. Every daemon in this
 * container shares its pid namespace, so a live pid IS a live owner. EPERM (a process owned by someone else)
 * counts as live for the same reason; only ESRCH means it is gone.
 *
 * WHAT THIS CANNOT ANSWER is whether the pid is still the process that took the claim: Linux recycles pids, and
 * a claim outliving its owner can be re-pointed at whatever inherited the number. Every caller here is a guard
 * deciding whether to TAKE something from that owner (its HOME, its marker, its processes), so the recycled
 * case resolves to "leave it alone", a leaked leftover rather than a live thing killed. That is the direction
 * to be wrong in, and the reason nothing in here tries to be cleverer. */
export const pidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};
