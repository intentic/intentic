import { z } from "zod";

export const AI_LITERACY_TEXT = {
    en: "You are working with an AI assistant. It can be wrong or invent facts, legal references and quotations. Check important claims against their sources. You remain responsible for decisions and anything you send. Share only the personal data needed for the task. Follow your office's rules for using AI. Report problems to the sandbox owner.",
    pl: "Pracujesz z asystentem AI. Może się mylić lub wymyślać fakty, przepisy i cytaty. Ważne informacje sprawdzaj w źródłach. Odpowiadasz za swoje decyzje i za to, co wysyłasz. Podawaj tylko dane osobowe potrzebne do zadania. Stosuj zasady korzystania z AI obowiązujące w urzędzie. Problemy zgłaszaj osobie, która zarządza tym sandboxem.",
    de: "Sie arbeiten mit einem KI-Assistenten. Er kann Fehler machen oder Fakten, Rechtsverweise und Zitate erfinden. Prüfen Sie wichtige Aussagen anhand der Quellen. Sie sind für Entscheidungen und versendete Inhalte verantwortlich. Geben Sie nur personenbezogene Daten ein, die für die Aufgabe nötig sind. Beachten Sie die KI-Regeln Ihrer Dienststelle. Melden Sie Probleme der verantwortlichen Person für diesen Arbeitsbereich.",
    fr: "Vous travaillez avec un assistant IA. Il peut se tromper ou inventer des faits, des références juridiques et des citations. Vérifiez les points importants dans les sources. Vous restez responsable de vos décisions et de ce que vous envoyez. Ne saisissez que les données personnelles nécessaires à la tâche. Respectez les règles de votre service sur l'IA. Signalez les problèmes au responsable de cet espace.",
    es: "Trabaja con un asistente de IA. Puede equivocarse o inventar hechos, referencias legales y citas. Compruebe los datos importantes en sus fuentes. Usted sigue siendo responsable de sus decisiones y de lo que envía. Introduzca solo los datos personales necesarios para la tarea. Siga las normas de su oficina sobre el uso de IA. Informe de los problemas a quien administra este espacio.",
} as const;
export const AiLiteracyLocaleSchema = z.enum(["en", "pl", "de", "fr", "es"]);
// The read names its language in the path, which an OpenAPI route takes from an object keyed by the parameter.
export const AiLiteracyQuerySchema = z.object({ locale: AiLiteracyLocaleSchema });
export const AiLiteracyConfirmSchema = z.object({ version: z.string().length(64), locale: AiLiteracyLocaleSchema });
export const AiLiteracyStatusSchema = z.object({ show: z.boolean(), text: z.string(), version: z.string(), confirmedAt: z.string().optional() });
export const AiLiteracyRecordSchema = z.object({ member: z.string(), version: z.string(), confirmedAt: z.string() });
export type AiLiteracyRecord = z.infer<typeof AiLiteracyRecordSchema>;
export const AiLiteracyListSchema = z.object({ records: z.array(AiLiteracyRecordSchema) });
