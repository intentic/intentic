import { plural } from "@intentic/base/format";

// The few phrases every finding's sentence is built from, so Windows, Linux and macOS say a timeout or a plan alike.

// A timeout as a person says it: "5 hours", "1 hour 30 minutes", "90 seconds" reads "1 minute 30 seconds". Pure.
export const durationWords = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    const parts = [hours > 0 ? plural(hours, "hour") : "", minutes > 0 ? plural(minutes, "minute") : "", rest > 0 ? plural(rest, "second") : ""];
    return parts.filter((part) => part !== "").join(" ") || "0 seconds";
};

// " (plan: Balanced)" or " (plans: Performance, Turbo)"; nothing for none. Pure.
export const plansPhrase = (plans: readonly string[]): string => (plans.length === 0 ? "" : ` (${plans.length === 1 ? "plan" : "plans"}: ${plans.join(", ")})`);

// A local hour as a clock shows it: 2 → "02:00". Pure.
export const hourWords = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;
