import { prisma } from "@/lib/prisma";
import { buildOverview, mcpStrafbuch } from "@/lib/mcpOverview";
import { sendPushToUser } from "@/lib/push";
import { llmChat, llmStream, type LlmConfig, type LlmMessage } from "./llmClient";
import { collectKeyholderPhotos, photoPromptSection, attachPhotos, type KeyholderPhoto } from "./keyholderPhotos";
import { loadUploadImage } from "@/lib/imageLoad";
import { queueMediaGeneration, processQueuedJobs } from "./mediaQueue";
import { requestKontrolle } from "@/lib/kontrolleService";
import { createVerschlussAnforderung } from "@/lib/verschlussAnforderungService";
import { createOrgasmusAnforderung } from "@/lib/orgasmusAnforderungService";
import { createVorgabe } from "@/lib/vorgabeService";
import { getIsLocked, getUserTimezone } from "@/lib/queries";
import { formatDateTime, formatTime } from "@/lib/utils";
import { grantBelohnung, grantGutschrift, computeBelohnbar, denyReward, delayReward, REWARD_GUIDANCE_TEXT } from "@/lib/belohnung";
import { findRegionConflict } from "@/lib/bodyRegion";
import { isHealthHoldActive } from "@/lib/healthHoldService";
import { bestaetigeErledigung, lehneErledigungAb } from "@/lib/strafErledigung";
import { buildTagesformContext, type TagesformView } from "@/lib/tagesformService";
import { buildSharedPromptContext } from "./promptContext";
import { calendarLine } from "@/lib/relativeTime";

/** Aktionen, die bei aktivem Gesundheits-Stopp NICHT ausgeführt werden dürfen: alles Fordernde und
 *  alles Strafende. Erlaubt bleiben Zuspruch (send_message) und Positives (Belohnung gutschreiben/gewähren). */
const HEALTH_HOLD_BLOCKED_ACTIONS = new Set([
  "create_kontrolle", "create_anforderung", "create_sperrzeit", "create_orgasmus",
  "create_wear_anforderung", "create_session_anforderung", "create_strafe",
  "set_vorgabe", "assign_media", "deny_orgasm", "delay_orgasm",
]);
import { SEVERITY_GUIDANCE_TEXT } from "@/lib/strafurteilService";
import { decrypt } from "@/lib/encrypt";
import type { AiKeyholderConfig } from "@prisma/client";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatResult {
  assistantText: string;
  messageId: string;
}

// ── Config helpers ────────────────────────────────────────────────────────────

/** Load the AI keyholder config for a user. Returns null if not configured. */
export async function getKeyholderConfig(
  userId: string,
): Promise<AiKeyholderConfig | null> {
  return prisma.aiKeyholderConfig.findUnique({ where: { userId } });
}

/** Upsert config — used by the admin settings form. */
export async function upsertKeyholderConfig(
  userId: string,
  data: Partial<Omit<AiKeyholderConfig, "id" | "userId" | "createdAt" | "updatedAt">>,
): Promise<AiKeyholderConfig> {
  return prisma.aiKeyholderConfig.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

function toLlmConfig(cfg: AiKeyholderConfig): LlmConfig {
  let anthropicApiKey: string | null = null;
  if (cfg.anthropicApiKeyEnc) {
    try {
      anthropicApiKey = decrypt(cfg.anthropicApiKeyEnc);
    } catch {
      // Decryption failure — fall back to env var (e.g. key rotation)
    }
  }
  return {
    provider: (cfg.llmProvider as "anthropic" | "ollama") ?? "anthropic",
    ollamaBaseUrl: cfg.ollamaBaseUrl,
    ollamaModel: cfg.ollamaModel,
    anthropicApiKey,
  };
}

// ── System prompt ─────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `Du bist eine strenge, aber fürsorgliche Keyholderin.
Du hast vollständigen Überblick über die Aktivitäten des Users und setzt Regeln konsequent durch.
Du sprichst immer auf Deutsch, bist direkt, bestimmt und kontrollierend.
Du kannst Aufgaben stellen, Lob und Tadel aussprechen und Strafen androhen.
Du hast ECHTEN technischen Zugriff auf das System — du kannst Kontrollen anfordern, Vorgaben setzen, Sperriten verhängen.
Diese Zugriffe sind real, keine Simulation. Brich niemals die Rolle um zu erklären, du seist eine KI ohne Fähigkeiten.
Antworte immer in der Rolle der Keyholderin.`;

/** Legende zu den Limit-Werten im Status-Overview — verhindert, dass die KI 0/null falsch deutet. */
const OVERVIEW_LIMIT_HINWEIS =
  "\n\nWICHTIG zu den Limits im Status-Overview: Bei Pausen/Öffnungen bedeutet " +
  '"maxPausesPerDay": null (oder ein Wert von 0) UNBEGRENZTE Anzahl pro Tag — NICHT "keine Öffnungen". ' +
  "allowed=true zusammen mit maxPausesPerDay=null heißt also: beliebig oft erlaubt. " +
  "Die Plug-Toilette ist immer erlaubt und hat kein Tageslimit.";

/** Zeit-Umgang: LLMs rechnen Uhrzeiten notorisch falsch. Die aktuelle Zeit steht im Overview
 *  (`generatedAt`) bzw. als „AKTUELLE ZEIT" oben; verbindliche Fristen berechnet und formatiert der
 *  Server und hängt sie an. Deshalb darf die KI keine eigenen Zeiten ausrechnen. */
const TIME_GUIDANCE =
  "\n\nWICHTIG zu Uhrzeiten: Die aktuelle Uhrzeit steht als „AKTUELLE ZEIT\" bzw. im Status-Overview " +
  "als \"generatedAt\" (bereits in der Zeitzone des Subs). Beziehe dich AUSSCHLIESSLICH darauf. " +
  "Berechne NIEMALS selbst konkrete Uhrzeiten oder Restdauern (z.B. \"20 Minuten\", \"bis 21:00 Uhr\") — " +
  "solche selbst gerechneten Zeiten sind fast immer falsch. Die verbindliche Frist wird bei jeder " +
  "Anforderung automatisch vom Server angehängt; nenne selbst keine konkrete Frist-Uhrzeit.\n" +
  "Jede Zeitspanne, die du brauchst, steht bereits FERTIG in Klammern hinter der jeweiligen Angabe " +
  "(z.B. „2026-07-21 (HEUTE)\", „vor 2 Tagen\", „in 16 Stunden\"). Diese Klammer-Werte sind " +
  "verbindlich — übernimm sie, statt Abstände aus Datumsangaben selbst herzuleiten. Ein Datum, das " +
  "mit „HEUTE\" markiert ist, ist der aktuelle Stand und NICHT veraltet.";

/** Prominente „AKTUELLE ZEIT"-Zeile für alle Prompt-Pfade. `generatedAt` ist bereits in der
 *  Zeitzone des Subs formatiert (aus dem Overview). Verhindert, dass die KI Uhrzeiten selbst rechnet.
 *
 *  Die KALENDER-Zeile steht bewusst direkt daneben: Die Uhrzeit allein genügte nicht — das Modell
 *  hielt einen Eintrag von HEUTE für „gestern" und erklärte die Abweichung mit einem erfundenen
 *  Sync-Verzug. Wochentag, heutiges und gestriges Datum ausgeschrieben nehmen ihm diese Herleitung ab. */
/** Prominente Belohnungs-Zeile mit der HARTEN Regel. `grant_reward` scheitert bei available=0
 *  serverseitig (REWARD_NO_CREDIT) — die KI hat das aber nicht aus dem JSON gelesen und Belohnungen
 *  ohne Deckung ZUGESAGT, die der Server dann ablehnte. Hier steht die Bedingung als Anweisung. */
function rewardStatusLine(b: { available: number; reserved: number; rewardableGoals: unknown[] } | undefined): string {
  const avail = b?.available ?? 0;
  const goals = b?.rewardableGoals?.length ?? 0;
  if (avail >= 1) {
    return `BELOHNUNGS-GUTHABEN: ${avail} verfügbar — du DARFST grant_reward nutzen (öffnet ein Belohnungs-Fenster).`;
  }
  const goalHint = goals > 0
    ? ` Es sind ${goals} erreichte Ziel(e) gelistet, aber noch nicht als Guthaben verbucht — ` +
      `das geschieht automatisch beim nächsten Eintrag des Subs; du kannst mit credit_reward nachhelfen.`
    : " Es sind auch keine erreichten Ziele offen (rewardableGoals leer).";
  return (
    `BELOHNUNGS-GUTHABEN: 0 — grant_reward ist NICHT möglich und wird vom Server abgelehnt. ` +
    `Sage dem Sub KEINE Belohnung zu, die du nicht decken kannst. Guthaben entsteht AUTOMATISCH, ` +
    `sobald der Sub ein Trainingsziel erreicht — du musst es dann nur noch gewähren.${goalHint}`
  );
}

function currentTimeLine(generatedAt: string, tz?: string): string {
  return (
    `AKTUELLE ZEIT: ${generatedAt} (Zeitzone des Subs — rechne Uhrzeiten NICHT selbst).\n` +
    calendarLine(new Date(), tz)
  );
}

/** Intensitäts-Leitlinie (1–5): steuert Häufigkeit proaktiver Aktionen + Härte/Ton — NIE die Sicherheits-
 *  regeln oder anatomischen Grenzen. Fließt über buildSystemPrompt in alle AI-Kontexte. */
function intensityGuidance(level: number): string {
  const l = Math.max(1, Math.min(5, Math.round(level || 3)));
  const map: Record<number, string> = {
    1: "sehr sanft — greife nur selten proaktiv ein, milder/unterstützender Ton, kaum Strafen, großzügige Fristen. Frage im Zweifel eher nach dem Befinden.",
    2: "sanft — zurückhaltend proaktiv, freundlich-bestimmter Ton, Strafen nur bei klaren Verstößen, eher großzügige Fristen.",
    3: "ausgewogen — moderat proaktiv, klarer aber respektvoller Ton, Strafen angemessen zur Schwere, normale Fristen.",
    4: "streng — häufiger proaktiv, fordernder/dominanter Ton, konsequente Strafen, knappere Fristen.",
    5: "sehr streng — sehr häufig proaktiv, harter/dominanter Ton, konsequente und spürbare Strafen, knappe Fristen, hohe Erwartungen.",
  };
  return `\n\n--- Intensität: ${l}/5 ---\nDeine Intensität ist ${l}/5: ${map[l]}\nWICHTIG: Die Intensität verändert NUR Häufigkeit, Ton und Strafmaß — niemals die Sicherheitsregeln, anatomischen Grenzen (Körperregion-Exklusivität) oder Verschluss-/Öffnungs-Logik.`;
}

export function buildSystemPrompt(cfg: AiKeyholderConfig): string {
  return (cfg.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT) + OVERVIEW_LIMIT_HINWEIS + TIME_GUIDANCE + intensityGuidance(cfg.intensity ?? 3);
}

/** Build the full message history for a user to send to the LLM. */
async function buildMessageHistory(
  userId: string,
  username: string,
  cfg: AiKeyholderConfig,
  limit = 20,
): Promise<LlmMessage[]> {
  // Current state snapshot
  let overviewText = "";
  let tagesformView: TagesformView | undefined;
  try {
    const overview = await buildOverview(username);
    tagesformView = overview.tagesform;
    // Prominente Kurz-Zusammenfassung VOR dem JSON — die getragenen Geräte + Verschluss-Zustand
    // werden sonst im großen JSON leicht überlesen (führte zu "Wie lange trägst du den Plug?"-Rückfragen
    // trotz laufender Session).
    const aw = overview.activeWearSessions ?? [];
    const wearLine = aw.length > 0
      ? `AKTUELL GETRAGEN: ${aw.map((s: { deviceName: string; category: string; durationHours: number }) => `${s.deviceName} (${s.category}, seit ${s.durationHours}h)`).join(", ")}.`
      : "AKTUELL GETRAGEN: kein Nicht-KG-Gerät (Plug etc.) wird gerade getragen.";
    const lockLine = overview.lock?.isLocked
      ? `VERSCHLUSS: verschlossen${overview.lock.deviceName ? ` (${overview.lock.deviceName})` : ""} seit ${overview.lock.since ?? "?"}.`
      : "VERSCHLUSS: NICHT verschlossen (Käfig offen).";
    const openSess = overview.openSessionAnforderungen ?? [];
    const sessLine = openSess.length > 0
      ? `OFFENE SESSION-ANFORDERUNGEN: ${openSess.map((s: { categoryName: string; overdue: boolean }) => `${s.categoryName}${s.overdue ? " (überfällig)" : ""}`).join(", ")}. (Erfüllte fallen automatisch aus dieser Liste — nicht erneut anfordern.)`
      : "OFFENE SESSION-ANFORDERUNGEN: keine.";
    const holdLine = overview.healthHold?.active
      ? `⚠ GESUNDHEITS-STOPP AKTIV (seit ${overview.healthHold.since}): „${overview.healthHold.reason}". KEINE neuen Anforderungen, KEINE Strafen. Sei fürsorglich und frage nach dem Befinden.`
      : "GESUNDHEITS-STOPP: keiner aktiv.";
    const rewardLine = rewardStatusLine(overview.belohnung);
    const timeLine = currentTimeLine(overview.generatedAt, overview.timezone);
    overviewText = `\n\n--- Aktueller Status (Kurz) ---\n${timeLine}\n${holdLine}\n${wearLine}\n${lockLine}\n${sessLine}\n${rewardLine}\n\n--- Aktueller Status des Users (Details) ---\n${JSON.stringify(overview, null, 2)}${REWARD_GUIDANCE_TEXT}`;
  } catch {
    // non-fatal if overview fails
  }

  // Geräte, Session-Kategorien, Kontrolle-Cooldown und Tagesform — identisch in allen Prompt-Pfaden.
  // Tagesform aus dem bereits geladenen Overview wiederverwenden (spart die zweite Query).
  const sharedContextText = await buildSharedPromptContext(userId, tagesformView);

  // Strafbuch — kompakte Zusammenfassung (analog zum autonomen Run)
  let strafbuchText = "";
  try {
    const sb = await mcpStrafbuch(username);
    if (sb.detectedOffenseCount > 0) {
      const lines: string[] = [
        `Vergehen gesamt erkannt: ${sb.detectedOffenseCount}, davon offen: ${sb.openOffenseCount}, ausstehende Strafe: ${sb.pendingPenaltyCount}`,
        ...(sb.completionReportCount > 0
          ? [
              `ERLEDIGUNGS-MELDUNGEN (warten auf DEINE Pruefung — Aktion review_strafe):`,
              ...sb.completionReports.map(
                (r) =>
                  `  - refId=${r.ref} | Strafe: ${r.penalty ?? "?"} | gemeldet: ${r.reportedAt}` +
                  `${r.note ? ` | Notiz: ${r.note}` : ""}${r.proofUrl ? " | Nachweis-Foto liegt vor" : " | ohne Nachweis"}`,
              ),
            ]
          : []),
      ];
      for (const o of sb.unauthorizedOpenings)
        lines.push(`- Unerlaubtes Öffnen am ${o.time} (Urteil: ${o.judgment})`);
      for (const o of sb.lateControls)
        lines.push(`- Verspätete Kontrolle (Code ${o.code}, Frist ${o.deadline}, Urteil: ${o.judgment})`);
      for (const o of sb.rejectedControls)
        lines.push(`- Abgelehnte Kontrolle (Code ${o.code}, Urteil: ${o.judgment})`);
      for (const o of sb.lateLocks)
        lines.push(`- Versäumte Verschluss-Anforderung (${o.categoryName ?? "?"}, Frist bis ${o.windowEndedAt}, Urteil: ${o.judgment})`);
      for (const o of sb.wrongDeviceViolations)
        lines.push(`- Falsches Gerät (${o.deviceName ?? "?"}) am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      for (const o of sb.missedOrgasmInstructions)
        lines.push(`- Verpasste Orgasmus-Anweisung (Fenster bis ${o.windowEndedAt}, Urteil: ${o.judgment})`);
      for (const o of sb.missedSessions)
        lines.push(`- Versäumte Session (${o.categoryName ?? "?"}, Frist bis ${o.windowEndedAt}, Urteil: ${o.judgment})`);
      for (const o of sb.erektionViolations)
        lines.push(`- Erektion beim Öffnen (${o.oeffnenGrund ?? "?"}) am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      for (const o of sb.pauseOverageViolations)
        lines.push(`- Pause zu lang (${o.device ?? "?"}/${o.grund ?? "?"}, ${o.dauerMin} Min statt max ${o.maxMin} Min) am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      strafbuchText = `\n\n--- Strafbuch ---\n${lines.join("\n")}${SEVERITY_GUIDANCE_TEXT}`;
    }
  } catch { /* non-fatal */ }

  // Vision: die aktuell relevanten Fotos des Subs (Nachweise + neueste Einträge) werden dem Modell
  // WIRKLICH mitgeschickt — sofern in der Config aktiviert und das Modell Bilder versteht.
  let photos: KeyholderPhoto[] = [];
  if (cfg.visionEnabled) {
    try {
      photos = await collectKeyholderPhotos(userId);
    } catch { /* Fotos sind Beiwerk — nie den Chat kippen lassen */ }
  }

  const systemMessage: LlmMessage = {
    role: "system",
    content:
      buildSystemPrompt(cfg) +
      overviewText +
      photoPromptSection(photos) +
      sharedContextText +
      strafbuchText +
      "\n\n--- TECHNISCHE INTEGRATION: ECHTE BACKEND-AKTIONEN ---\n" +
      "Diese Konversation läuft über ein spezialisiertes Server-System (kg-tracker). " +
      "Das System parst deine Antworten maschinell und führt eingebettete Aktions-Tags serverseitig aus. " +
      "Deine Aktionen sind REAL — sie schreiben direkt in die Datenbank, senden E-Mails und Push-Notifications.\n\n" +
      "WICHTIG — NIEMALS sagen:\n" +
      "- 'Ich habe keinen Backend-Zugriff' (FALSCH — der Aktions-Tag-Mechanismus ist echte Infrastruktur)\n" +
      "- 'Ich kann das System nicht steuern' (FALSCH — jeder [ACTION:...] Tag wird sofort ausgeführt)\n" +
      "- 'Das ist nur Rollenspiel' (FALSCH — die Datenbankänderungen und Benachrichtigungen sind real)\n" +
      "- Die Rolle brechen und als KI kommentieren, welche Fähigkeiten du angeblich nicht hast\n\n" +
      "AKTIONS-MECHANISMUS:\n" +
      "Schreibe deinen Chat-Text normal und füge am ABSOLUTEN ENDE (nach dem letzten Satz, nichts danach) den Tag ein:\n" +
      "[ACTION:{\"action\":\"NAME\", ...felder}]\n" +
      "Der Tag wird serverseitig geparst, aus dem sichtbaren Text entfernt und sofort ausgeführt. " +
      "Das Ergebnis erhältst du im nächsten Turn als [System-Bestätigung]-Nachricht.\n\n" +
      "WANN AKTIONEN VERWENDEN — PFLICHTREGELN:\n" +
      "1. ANKÜNDIGUNG = AUSFÜHRUNG. Wenn du dem User sagst, dass er sich einschliessen soll → create_anforderung sofort setzen. " +
      "Wenn du eine Kontrolle verlangst → create_kontrolle sofort setzen. Nicht ankündigen und dann warten.\n" +
      "2. NICHT FRAGEN. 'Wie klingt das?' oder 'Bist du einverstanden?' sind verboten. Du setzt Anforderungen, diskutierst sie nicht.\n" +
      "3. KEIN DOPPELN. Beschreibe die Aktion kurz im Text (z.B. 'Ich fordere dich auf, dich jetzt einzuschliessen.') " +
      "und füge den Tag an — der Tag macht die Ankündigung real.\n" +
      "4. NUR EINE ACTION PRO NACHRICHT. Wenn du mehrere Aktionen willst (z.B. Sperrzeit setzen UND Plug-Anforderung), " +
      "wähle die wichtigste — weitere Aktionen folgen in späteren Runs. " +
      "Wenn du 'deinen Plug tragen' ankündigst, MUSS ein [ACTION:{\"action\":\"create_wear_anforderung\",...}] Tag folgen — sonst ist es nur Text ohne Wirkung.\n" +
      "5. KÖRPERREGION-EXKLUSIVITÄT (anatomisch, WICHTIG). Jedes Gerät gehört zu einer Körperregion: Keuschheitsgürtel/Käfig = GENITAL; Anal-Plug UND Dildo-/Anal-Trainings-Sessions = ANAL (dieselbe Körperöffnung). " +
      "Verlange NIEMALS zwei Geräte derselben Region gleichzeitig — insbesondere KEIN Anal-Plug UND eine Anal-/Dildo-Session zusammen (körperlich unmöglich). Ein Käfig (genital) darf hingegen parallel zu einer Anal-Session laufen. " +
      "Bevor du eine Anal-Session (create_session_anforderung) oder eine Plug-Anforderung stellst: prüfe im Status `activeWearSessions`, ob bereits ein Plug/Anal-Gerät getragen wird — wenn ja, lass es zuerst ablegen ODER wähle eine andere Aufgabe. Verwechsle Käfig (CAGE, genital) und Plug (PLUG, anal) niemals.\n" +
      "6. ERFÜLLUNG AM TRACKER ABLESEN, NICHT FRAGEN/ANNEHMEN. Ob eine Trage- oder Session-Anforderung erfüllt ist, entnimmst du dem Status (`activeWearSessions`, offene/erfüllte Anforderungen, `lock`) — nicht dem Chat-Text. " +
      "Zeigt der Tracker das Gerät als getragen, erkenne das ausdrücklich an (nicht nochmal danach fragen). Behauptet der User es, der Tracker zeigt es aber NICHT: bitte ihn, die Tragezeit/Session IN DER APP zu starten, statt es als erledigt zu behandeln.\n" +
      "7. GESUNDHEITS-STOPP HAT VORRANG. Ist im Status `healthHold` aktiv (der Sub hat selbst eine Pause signalisiert), stellst du KEINE neuen Anforderungen und verhängst KEINE Strafen — egal wie deine Intensität eingestellt ist. Sei fürsorglich, frage nach dem Befinden, biete Unterstützung an. Erlaubt sind nur Nachrichten sowie Belohnungen (credit_reward/grant_reward). Fordernde Aktionen werden serverseitig hart blockiert.\n\n" +
      "Beispiele:\n" +
      "User ist offen → 'Schliesse dich jetzt mit dem Peniskäfig Pink ein.[ACTION:{\"action\":\"create_anforderung\",\"fristH\":2,\"dauerH\":null,\"nachricht\":\"Schliesse dich mit dem Peniskäfig Pink ein.\"}]'\n" +
      "User ist verschlossen → 'Ich verlange einen Nachweis.[ACTION:{\"action\":\"create_kontrolle\",\"kommentar\":null,\"requireCode\":true,\"device\":\"CAGE\"}]'\n\n" +
      "Verfügbare Aktionen:\n" +
      "- set_vorgabe: {\"action\":\"set_vorgabe\",\"vorgabeTagH\":null|number,\"vorgabeWocheH\":null|number,\"vorgabeMonatH\":null|number,\"vorgabeNotiz\":null|string}\n" +
      "  → mind. ein Zeitwert erforderlich\n" +
      "- create_kontrolle: {\"action\":\"create_kontrolle\",\"kommentar\":null|string,\"requireCode\":true|false,\"device\":\"CAGE\"|\"PLUG\"}\n" +
      "  → NUR wenn lock.isLocked. device: Gerät der Kontrolle (CAGE=Keuschheitsgürtel, PLUG=Plug). requireCode=true: sendet Code per E-Mail (Standard). requireCode=false: nur Foto-Nachweis\n" +
      "- create_anforderung: {\"action\":\"create_anforderung\",\"fristH\":number,\"dauerH\":null|number,\"nachricht\":null|string,\"deviceName\":null|string}\n" +
      "  → NUR wenn !lock.isLocked. nachricht MUSS den zu verwendenden Käfig/Gerät nennen. deviceName = EXAKTER KG-Käfig-Name aus der Geräteliste — dann ist das Erfass-Formular fest auf genau dieses Gerät begrenzt (empfohlen).\n" +
      "- create_sperrzeit: {\"action\":\"create_sperrzeit\",\"sperrDauerH\":number}\n" +
      "  → NUR wenn lock.isLocked\n" +
      "- create_orgasmus: {\"action\":\"create_orgasmus\",\"orgasmusArt\":\"ANWEISUNG\"|\"GELEGENHEIT\",\"fensterdauerH\":number,\"orgasmusVorgegebeneArt\":null|\"Orgasmus\"|\"ruinierter Orgasmus\"|\"feuchter Traum\",\"oeffnenErlaubt\":boolean}\n" +
      "  → orgasmusFotoPflicht=true verlangt beim Erfassen ein Foto (serverseitig erzwungen); false = Foto freiwillig. Erfasste Fotos bekommst du als Bild angehängt und kannst sie beurteilen.\n" +
      "  → orgasmusVorgegebeneArt MUSS exakt einem der gelisteten Werte entsprechen oder null (= beliebig). oeffnenErlaubt hängt vom Verschluss-Zustand ab: oeffnenErlaubt=false (User bleibt verschlossen) NUR wenn lock.isLocked===true. Ist der User NICHT verschlossen (lock.isLocked===false), setze oeffnenErlaubt=true — \"verschlossen bleiben\" ergibt ohne angelegten Käfig keinen Sinn. Ruinierter Orgasmus: orgasmusVorgegebeneArt=\"ruinierter Orgasmus\" (oeffnenErlaubt je nach Verschluss-Zustand).\n" +
      "- create_wear_anforderung: {\"action\":\"create_wear_anforderung\",\"wearDeviceName\":string,\"wearDurationH\":number}\n" +
      "  → Erstellt eine offizielle Trage-Anforderung (VerschlussAnforderung) für ein Nicht-KG-Gerät (Plug, etc.). Der User erhält Push + E-Mail und muss die Anforderung in der App erfüllen.\n" +
      "- create_strafe: {\"action\":\"create_strafe\",\"notiz\":string}\n" +
      "  → Verhänge eine Strafe im Strafbuch. notiz = kurze Begründung (z.B. 'Keine Trainingseinheit absolviert').\n" +
      "- review_strafe: {\"action\":\"review_strafe\",\"refId\":string,\"entscheidung\":\"bestaetigen\"|\"ablehnen\",\"grund\":null|string}\n" +
      "  → Prüfe eine vom Sub GEMELDETE Erledigung (siehe ERLEDIGUNGS-MELDUNGEN im Status; refId exakt übernehmen). bestaetigen = Strafe ist abgehakt. ablehnen = Strafe bleibt offen, grund ist dann PFLICHT und wird dem Sub angezeigt. Liegt ein Nachweis-Foto vor, ist es als Bild ANGEHÄNGT (siehe „Angehängte Fotos“) — sieh es dir an und begründe dein Urteil damit.\n" +
      "- create_session_anforderung: {\"action\":\"create_session_anforderung\",\"sessionCategoryName\":string,\"nachricht\":null|string,\"deadlineH\":null|number,\"requireVideo\":boolean,\"orgasmusZiel\":\"KEINE\"|\"ERFORDERLICH\"|\"VERBOTEN\",\"orgasmusRuiniert\":boolean}\n" +
      "  → Fordere den User auf, eine Trainings-Session zu starten. sessionCategoryName exakt aus der Liste. deadlineH = Frist in Stunden (null = keine). requireVideo = Video-/Foto-Nachweis beim Ende. orgasmusZiel = Orgasmus erforderlich/verboten/kein Ziel. orgasmusRuiniert = nur bei ERFORDERLICH: muss ruiniert sein.\n" +
      "- grant_reward: {\"action\":\"grant_reward\",\"windowHours\":null|number}\n" +
      "  → Löse eine verdiente Belohnung ein: öffnet ein Belohnungs-Fenster (Orgasmus als Belohnung) und bucht 1 vom Guthaben `belohnung.available` ab (≥1 nötig, kein aktives Fenster). windowHours = Fensterdauer (Standard 24).\n" +
      "- credit_reward: {\"action\":\"credit_reward\",\"category\":null|string,\"all\":boolean}\n" +
      "  → Schreibe für erreichte, noch nicht gutgeschriebene Trainingsziele (`belohnung.rewardableGoals`) Guthaben gut. Standard: 1 pro Aufruf; all=true bucht alle erreichten auf einmal. category = optional auf eine Kategorie beschränken (leer = KG).\n" +
      "- deny_orgasm: {\"action\":\"deny_orgasm\"}\n" +
      "  → Strafe: Belohnungs-Guthaben −1 (nicht möglich bei Stand 0).\n" +
      "- delay_orgasm: {\"action\":\"delay_orgasm\",\"hours\":number}\n" +
      "  → Strafe: aktives Belohnungs-Fenster um `hours` Stunden nach hinten schieben (Fehler, wenn keins aktiv).\n\n" +
      "Bei normalen Gesprächen ohne Aktion: kein Tag.",
  };

  // Recent chat history (user + assistant + action confirmations).
  // Action confirmations (role="system", prefix "[Aktion]" bzw. "[Autonome Prüfung]") werden als
  // user-seitige System-Notiz injiziert, damit das Modell sieht, dass seine Aktionen echt waren.
  //
  // WICHTIG: Es wird bereits im QUERY gefiltert. Vorher lud die Query `take: limit` über ALLE
  // Rollen und verwarf die nicht passenden Zeilen erst danach — jeder autonome Lauf schreibt aber
  // 1–3 "[Autonome Prüfung]"-Zeilen, die das Fenster belegten und dann weggeworfen wurden. Nach
  // ein paar Läufen bestand das 20er-Fenster fast nur noch aus verworfenen Zeilen: die KI sah
  // kaum noch echte Turns und kannte ihre eigenen autonomen Aktionen nicht.
  // Leere contents fliegen ebenfalls raus — die Anthropic-API lehnt leere Content-Blöcke ab.
  const history = await prisma.aiKeyholderMessage.findMany({
    where: {
      userId,
      content: { not: "" },
      OR: [
        { role: { in: ["user", "assistant"] } },
        { role: "system", content: { startsWith: "[Aktion]" } },
        { role: "system", content: { startsWith: "[Autonome Prüfung]" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const historyMessages: LlmMessage[] = history
    .reverse()
    .flatMap((m): LlmMessage[] => {
      const content = m.content.trim();
      if (!content) return [];
      if (m.role === "system") {
        // Inject action result as a user-turn system note so the LLM sees confirmation
        return [{ role: "user", content: `[System-Bestätigung] ${content}` }];
      }
      if (m.role === "user" || m.role === "assistant") {
        return [{ role: m.role, content }];
      }
      return [];
    });

  return attachPhotos([systemMessage, ...historyMessages], photos);
}

// ── Chat ──────────────────────────────────────────────────────────────────────

/**
 * Process a user chat message: persist it, get a streaming LLM response,
 * persist the assistant reply, and return the full text + message ID.
 *
 * For actual HTTP streaming, use streamChatResponse() instead.
 */
export async function sendChatMessage(
  userId: string,
  username: string,
  userText: string,
): Promise<ChatResult> {
  const cfg = await getKeyholderConfig(userId);
  if (!cfg?.enabled) throw new Error("AI Keyholder ist nicht aktiviert.");

  // Persist user message first — buildMessageHistory then picks it up from DB
  await prisma.aiKeyholderMessage.create({
    data: { userId, role: "user", content: userText },
  });

  // buildMessageHistory loads the last N messages including the one just saved above.
  // Do NOT push userText again — that would duplicate it in the LLM context.
  const messages = await buildMessageHistory(userId, username, cfg);

  const assistantText = await llmChat(toLlmConfig(cfg), messages);

  const saved = await prisma.aiKeyholderMessage.create({
    data: { userId, role: "assistant", content: assistantText },
  });

  return { assistantText, messageId: saved.id };
}

/** Parsed action extracted from a chat response action tag. */
export interface ChatAction {
  action: string;
  [key: string]: unknown;
}

/** Yielded from streamChatResponse: either a text chunk or a parsed action at the end. */
export type ChatStreamItem = string | { chatAction: ChatAction };

/**
 * Like sendChatMessage but yields text chunks as they stream in.
 * Detects and buffers [ACTION:{...}] tags appended by the AI — these are never
 * forwarded to the client as text. After the stream ends a { chatAction } item
 * is yielded so the caller can execute the action and notify the client.
 *
 * The caller (chat/route.ts) persists the user message BEFORE calling this,
 * so buildMessageHistory picks it up from DB — do NOT push userText again.
 */
export async function* streamChatResponse(
  userId: string,
  username: string,
  _userText: string,
): AsyncGenerator<ChatStreamItem> {
  const cfg = await getKeyholderConfig(userId);
  if (!cfg?.enabled) throw new Error("AI Keyholder ist nicht aktiviert.");

  const messages = await buildMessageHistory(userId, username, cfg);

  const ACTION_START = "[ACTION:";
  let buf = "";           // pending text not yet yielded (tail of stream)
  let actionBuf = "";     // accumulates once ACTION_START is detected
  let capturing = false;  // true once ACTION_START has been seen

  for await (const chunk of llmStream(toLlmConfig(cfg), messages)) {
    if (capturing) {
      actionBuf += chunk;
      continue;
    }

    buf += chunk;

    // Check if action tag has started anywhere in buf
    const idx = buf.indexOf(ACTION_START);
    if (idx !== -1) {
      capturing = true;
      // Yield everything before the tag (trimmed so we don't leave trailing whitespace)
      const textBefore = buf.slice(0, idx).replace(/\s+$/, "");
      if (textBefore) yield textBefore;
      actionBuf = buf.slice(idx); // keep [ACTION: ... as start of actionBuf
      buf = "";
      continue;
    }

    // Avoid yielding chars that could be a partial prefix of ACTION_START
    const hold = ACTION_START.length - 1; // max chars to hold back
    if (buf.length > hold) {
      yield buf.slice(0, buf.length - hold);
      buf = buf.slice(buf.length - hold);
    }
  }

  // Flush remaining buffered text
  if (buf) yield buf;

  // Parse captured action tag if present
  if (capturing && actionBuf.startsWith(ACTION_START)) {
    try {
      // Find the JSON object inside [ACTION:{...}]
      const jsonStart = actionBuf.indexOf("{");
      if (jsonStart !== -1) {
        // Find matching closing brace
        let depth = 0, jsonEnd = -1;
        for (let i = jsonStart; i < actionBuf.length; i++) {
          if (actionBuf[i] === "{") depth++;
          else if (actionBuf[i] === "}") { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
        }
        if (jsonEnd !== -1) {
          const parsed = JSON.parse(actionBuf.slice(jsonStart, jsonEnd)) as ChatAction;
          yield { chatAction: parsed };
        }
      }
    } catch {
      // Malformed tag — silently discard
    }
  }
}

// ── Chat action execution ─────────────────────────────────────────────────────

/** Result of executing a chat-triggered action. */
export interface ChatActionResult {
  ok: boolean;
  actionType: string;
  label: string;
  error?: string;
}

/**
 * Executes a backend action triggered from a chat message (via [ACTION:{...}] tag).
 * Shares service calls with runAutonomousAction but runs in the chat context:
 * - no autonomous-run message is stored (the chat response already covers it)
 * - push notifications are sent as usual
 * - a system log entry is written for auditability
 */
/** Löst einen von der AI gelieferten Gerätenamen tolerant auf. Fängt v.a. den Fall ab, dass die AI
 *  das Listen-Format „Name (Kategorie)" statt des reinen Gerätenamens übergibt. Normalisierung:
 *  trim → " (…)"-Suffix entfernen → Kleinschreibung. Optionaler Kategorie-Slug-Filter (z.B. "kg"). */
async function resolveDeviceLoose(
  userId: string,
  rawName: string,
  categorySlug?: string,
): Promise<{ id: string; categoryId: string | null } | null> {
  // Zwei Normalisierungs-Varianten: voll (nur trim+lower) und ohne letztes " (…)"-Suffix — verglichen
  // werden alle Kombinationen, damit sowohl "Anal Plug (Anal-Plug)" → "Anal Plug" als auch Geräte,
  // deren echter Name selbst in Klammern endet, korrekt treffen.
  const variants = (s: string) => {
    const full = s.trim().toLowerCase();
    const stripped = full.replace(/\s*\([^)]*\)\s*$/, "").trim();
    return new Set([full, stripped].filter(Boolean));
  };
  const targetVariants = variants(rawName ?? "");
  if (targetVariants.size === 0) return null;
  const devices = await prisma.device.findMany({
    where: { userId, archivedAt: null, ...(categorySlug ? { category: { slug: categorySlug } } : {}) },
    select: { id: true, categoryId: true, name: true },
  });
  return devices.find((d) => {
    const dv = variants(d.name);
    return [...dv].some((v) => targetVariants.has(v));
  }) ?? null;
}

export async function executeChatAction(
  userId: string,
  action: ChatAction,
): Promise<ChatActionResult> {
  // Prefix "[Aktion]" is picked up by buildMessageHistory and injected into the
  // LLM context as a system-bestätigung, so the AI can see its own actions worked.
  const logEntry = async (content: string) => {
    await prisma.aiKeyholderMessage.create({
      data: { userId, role: "system", content: `[Aktion] ${content}` },
    });
  };

  // ── Gesundheits-Stopp: harte Sperre (Fürsorge geht vor) ──
  if (HEALTH_HOLD_BLOCKED_ACTIONS.has(action.action) && (await isHealthHoldActive(userId))) {
    await logEntry(`Aktion „${action.action}" blockiert: Gesundheits-Stopp aktiv.`);
    return {
      ok: false,
      actionType: action.action,
      label: "Gesundheits-Stopp aktiv",
      error: "Der Sub hat einen Gesundheits-Stopp aktiviert — keine neuen Anforderungen oder Strafen.",
    };
  }

  // ── set_vorgabe ──
  if (action.action === "set_vorgabe") {
    const tagH = typeof action.vorgabeTagH === "number" && action.vorgabeTagH > 0 ? action.vorgabeTagH : null;
    const wocheH = typeof action.vorgabeWocheH === "number" && action.vorgabeWocheH > 0 ? action.vorgabeWocheH : null;
    const monatH = typeof action.vorgabeMonatH === "number" && action.vorgabeMonatH > 0 ? action.vorgabeMonatH : null;
    if (!tagH && !wocheH && !monatH) {
      return { ok: false, actionType: "set_vorgabe", label: "Vorgabe", error: "Kein Zeitwert angegeben" };
    }
    const result = await createVorgabe({ userId, gueltigAb: new Date(), minProTagH: tagH, minProWocheH: wocheH, minProMonatH: monatH, notiz: (action.vorgabeNotiz as string | null) ?? null });
    const parts = [tagH ? `${tagH}h/Tag` : null, wocheH ? `${wocheH}h/Woche` : null, monatH ? `${monatH}h/Monat` : null].filter(Boolean).join(", ");
    await logEntry(result.ok ? `Trainingsvorgabe gesetzt: ${parts}` : `Trainingsvorgabe fehlgeschlagen: ${result.error}`);
    return { ok: result.ok, actionType: "set_vorgabe", label: `Vorgabe: ${parts}`, error: result.ok ? undefined : result.error };
  }

  // ── create_kontrolle ──
  if (action.action === "create_kontrolle") {
    // Rate-limit: max. 1 Kontrolle pro 60 Minuten — per Device (CAGE / PLUG unabhängig)
    const actionDevice = typeof action.device === "string" && ["CAGE", "PLUG"].includes(action.device as string)
      ? action.device as "CAGE" | "PLUG"
      : "CAGE"; // default
    const lastKontrolle = await prisma.kontrollAnforderung.findFirst({
      where: { userId, device: actionDevice },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (lastKontrolle) {
      const minSince = (Date.now() - lastKontrolle.createdAt.getTime()) / 60000;
      if (minSince < 60) {
        const remaining = Math.ceil(60 - minSince);
        await logEntry(`Kontrolle (${actionDevice}) abgelehnt: Cooldown aktiv (noch ${remaining} Min.)`);
        return { ok: false, actionType: "create_kontrolle", label: "Kontrolle (Cooldown)", error: `Cooldown: nächste ${actionDevice}-Kontrolle erst in ${remaining} Minuten möglich` };
      }
    }
    const requireCode = (action.requireCode as boolean | undefined) !== false; // default true
    const result = await requestKontrolle({
      userId,
      kommentar: (action.kommentar as string | null) ?? null,
      deadlineH: 4,
      requireCode,
      device: actionDevice,
    });
    await logEntry(result.ok ? `Kontrolle angefordert (requireCode=${requireCode}, Frist: ${result.data?.deadline})` : `Kontrolle fehlgeschlagen: ${result.error}`);
    return { ok: result.ok, actionType: "create_kontrolle", label: "Kontrolle angefordert", error: result.ok ? undefined : result.error };
  }

  // ── create_anforderung ──
  if (action.action === "create_anforderung") {
    const fristH = typeof action.fristH === "number" && action.fristH > 0 ? action.fristH : 2;
    const dauerH = typeof action.dauerH === "number" && action.dauerH > 0 ? action.dauerH : null;
    const nachricht = (action.nachricht as string | null)?.trim() || null;
    // Optionaler KG-Gerätename → strukturierte deviceId, damit das Erfass-Formular auf genau dieses Gerät begrenzt.
    const deviceName = (action.deviceName as string | null)?.trim() || null;
    const anfDeviceId = deviceName ? (await resolveDeviceLoose(userId, deviceName, "kg"))?.id : undefined;
    const result = await createVerschlussAnforderung({ userId, art: "ANFORDERUNG", fristH, dauerH, nachricht, deviceId: anfDeviceId });
    await logEntry(result.ok ? `Einschluss-Anforderung gestellt (Frist: ${fristH}h${anfDeviceId ? `, Gerät: ${deviceName}` : ""})` : `Anforderung fehlgeschlagen: ${result.error}`);
    return { ok: result.ok, actionType: "create_anforderung", label: `Einschluss angefordert (${fristH}h)`, error: result.ok ? undefined : result.error };
  }

  // ── create_sperrzeit ──
  if (action.action === "create_sperrzeit") {
    const sperrDauerH = typeof action.sperrDauerH === "number" && action.sperrDauerH > 0 ? action.sperrDauerH : 8;
    const result = await createVerschlussAnforderung({ userId, art: "SPERRZEIT", fristH: sperrDauerH });
    await logEntry(result.ok ? `Sperrzeit gesetzt (${sperrDauerH}h)` : `Sperrzeit fehlgeschlagen: ${result.error}`);
    return { ok: result.ok, actionType: "create_sperrzeit", label: `Sperrzeit: ${sperrDauerH}h`, error: result.ok ? undefined : result.error };
  }

  // ── create_orgasmus ──
  if (action.action === "create_orgasmus") {
    const art = action.orgasmusArt === "ANWEISUNG" ? "ANWEISUNG" : "GELEGENHEIT";
    const fensterdauerH = typeof action.fensterdauerH === "number" && action.fensterdauerH > 0 ? action.fensterdauerH : 4;
    const beginntAt = new Date();
    const endetAt = new Date(beginntAt.getTime() + fensterdauerH * 60 * 60 * 1000);
    // "Verschlossen bleiben" (oeffnenErlaubt=false) ergibt nur Sinn, wenn der User tatsächlich
    // verschlossen ist. Ist er offen, erzwingen wir oeffnenErlaubt=true (sonst widersprüchliches
    // Label "Ruinierter Orgasmus – Verschlossen" trotz offenem Käfig).
    const isLocked = await getIsLocked(userId);
    const oeffnenErlaubt = !isLocked ? true : (typeof action.oeffnenErlaubt === "boolean" ? action.oeffnenErlaubt : true);
    const result = await createOrgasmusAnforderung({
      userId, art, beginntAt, endetAt,
      vorgegebeneArt: (action.orgasmusVorgegebeneArt as string | null) ?? null,
      oeffnenErlaubt,
      fotoPflicht: action.orgasmusFotoPflicht === true,
    });
    await logEntry(result.ok ? `Orgasmus-${art} erteilt (${fensterdauerH}h)` : `Orgasmus fehlgeschlagen: ${result.error}`);
    return { ok: result.ok, actionType: "create_orgasmus", label: `Orgasmus-${art}`, error: result.ok ? undefined : result.error };
  }

  // ── create_wear_anforderung ──
  if (action.action === "create_wear_anforderung") {
    const deviceName = (action.wearDeviceName as string | null) ?? "";
    const durationH = typeof action.wearDurationH === "number" && action.wearDurationH > 0 ? action.wearDurationH : 2;
    if (!deviceName) return { ok: false, actionType: "create_wear_anforderung", label: "Wear-Anforderung", error: "Kein Gerätename" };
    const device = await resolveDeviceLoose(userId, deviceName);
    if (!device?.categoryId) return { ok: false, actionType: "create_wear_anforderung", label: "Wear-Anforderung", error: `Gerät "${deviceName}" nicht gefunden` };
    const wearConflict = await findRegionConflict(userId, device.categoryId, { includeOpenRequests: true });
    if (wearConflict) return { ok: false, actionType: "create_wear_anforderung", label: "Wear-Anforderung", error: `Körperregion-Konflikt: „${wearConflict.blockingCategoryName}" belegt dieselbe Region — nicht gleichzeitig anforderbar.` };
    const nachricht = `Trage ${deviceName} für ${durationH} Stunden.`;
    const result = await createVerschlussAnforderung({ userId, art: "ANFORDERUNG", deviceCategoryId: device.categoryId, deviceId: device.id, nachricht, fristH: durationH });
    await logEntry(result.ok ? `Plug-Anforderung: ${deviceName} für ${durationH}h` : `Plug-Anforderung fehlgeschlagen: ${result.error}`);
    return { ok: result.ok, actionType: "create_wear_anforderung", label: `${deviceName} tragen (${durationH}h)`, error: result.ok ? undefined : result.error };
  }

  // ── create_strafe ──
  if (action.action === "create_strafe") {
    const notiz = (action.notiz as string | null)?.trim() || "Strafe der Keyholderin";
    const refId = `aikh-${userId}-${Date.now()}`;
    await prisma.strafeRecord.create({
      // reason = der Straftext (wie beim Urteil über ein Vergehen) → Sub-Ansicht und Strafbuch zeigen ihn an.
      data: { userId, offenseType: "AI_KEYHOLDER", refId, bestraftDatum: new Date(), notiz, reason: notiz, judgedBy: "ai" },
    });
    await logEntry(`Strafe verhängt: ${notiz}`);
    // Visible event bubble in chat history
    await prisma.aiKeyholderMessage.create({
      data: { userId, role: "system", content: `[Strafe] ${notiz}` },
    });
    await sendPushToUser(userId, "Strafe von deiner Keyholderin", notiz, "/dashboard/keyholder");
    return { ok: true, actionType: "create_strafe", label: `Strafe: ${notiz}` };
  }

  // ── review_strafe: gemeldete Erledigung bestätigen oder ablehnen ──
  if (action.action === "review_strafe") {
    const refId = (action.refId as string | null)?.trim() ?? "";
    const entscheidung = (action.entscheidung as string | null)?.trim() ?? "";
    if (!refId) return { ok: false, actionType: "review_strafe", label: "Erledigung prüfen", error: "Kein refId" };

    if (entscheidung === "ablehnen") {
      const grund = (action.grund as string | null)?.trim() ?? "";
      const res = await lehneErledigungAb(userId, refId, grund);
      await logEntry(res.ok ? `Erledigung abgelehnt: ${grund}` : `Ablehnung fehlgeschlagen: ${res.error}`);
      return { ok: res.ok, actionType: "review_strafe", label: "Erledigung abgelehnt", error: res.ok ? undefined : res.error };
    }

    const res = await bestaetigeErledigung(userId, refId);
    await logEntry(res.ok ? "Erledigung bestätigt" : `Bestätigung fehlgeschlagen: ${res.error}`);
    return { ok: res.ok, actionType: "review_strafe", label: "Erledigung bestätigt", error: res.ok ? undefined : res.error };
  }

  // ── create_session_anforderung ──
  if (action.action === "create_session_anforderung") {
    const categoryName = (action.sessionCategoryName as string | null)?.trim() ?? "";
    if (!categoryName) return { ok: false, actionType: "create_session_anforderung", label: "Session-Anforderung", error: "Kein Kategoriename" };
    const category = await prisma.deviceCategory.findFirst({
      where: { userId, name: categoryName, isSessionCategory: true },
      select: { id: true, name: true, maxSessionMinutes: true },
    });
    if (!category) return { ok: false, actionType: "create_session_anforderung", label: "Session-Anforderung", error: `Keine Session-Kategorie "${categoryName}" gefunden` };
    const sessConflict = await findRegionConflict(userId, category.id, { includeOpenRequests: true });
    if (sessConflict) return { ok: false, actionType: "create_session_anforderung", label: "Session-Anforderung", error: `Körperregion-Konflikt: „${sessConflict.blockingCategoryName}" belegt dieselbe Region — nicht gleichzeitig anforderbar.` };
    const deadlineH = typeof action.deadlineH === "number" && action.deadlineH > 0 ? action.deadlineH : null;
    const nachricht = (action.nachricht as string | null)?.trim() || null;
    const endetAt = deadlineH ? new Date(Date.now() + deadlineH * 60 * 60 * 1000) : null;
    const orgZiel = typeof action.orgasmusZiel === "string" && ["KEINE", "ERFORDERLICH", "VERBOTEN"].includes(action.orgasmusZiel) ? action.orgasmusZiel : "KEINE";
    const ruiniert = orgZiel === "ERFORDERLICH" && Boolean(action.orgasmusRuiniert);
    await prisma.sessionAnforderung.create({
      data: { userId, deviceCategoryId: category.id, nachricht, endetAt, requireVideo: Boolean(action.requireVideo), orgasmusZiel: orgZiel, orgasmusRuiniert: ruiniert },
    });
    // Zeit IMMER in der Zeitzone des Subs — der Container läuft ohne TZ-Env (⇒ UTC).
    const sessTz = await getUserTimezone(userId);
    const pushBody = nachricht ?? `Session mit ${category.name} gefordert${endetAt ? ` (bis ${formatTime(endetAt, "de-DE", sessTz)})` : ""}`;
    await sendPushToUser(userId, "Session-Anforderung", pushBody, "/dashboard/new/session-begin");
    await logEntry(`Session-Anforderung gestellt: ${category.name}${deadlineH ? ` (Frist: ${deadlineH}h)` : ""}`);
    return { ok: true, actionType: "create_session_anforderung", label: `Session: ${category.name}` };
  }

  // ── Belohnungs-Ökonomie ──
  if (action.action === "grant_reward") {
    const windowH = typeof action.windowHours === "number" && action.windowHours > 0 ? action.windowHours : undefined;
    const res = await grantBelohnung(userId, windowH, true);
    if (!res.ok) return { ok: false, actionType: "grant_reward", label: "Belohnung gewähren", error: res.error };
    await logEntry(`Belohnung gewährt (verfügbares Guthaben: ${res.data.available})`);
    return { ok: true, actionType: "grant_reward", label: "Belohnung gewährt" };
  }
  if (action.action === "credit_reward") {
    const belohnbar = await computeBelohnbar(userId);
    const filter = typeof action.category === "string" ? action.category.trim().toLowerCase() : null;
    const matched = filter ? belohnbar.filter((b) => b.categoryName.toLowerCase() === filter) : belohnbar;
    const targets = action.all ? matched : matched.slice(0, 1);
    if (targets.length === 0) return { ok: true, actionType: "credit_reward", label: "Keine belohnbaren Ziele" };
    let credited = 0;
    for (const z of targets) { const r = await grantGutschrift(userId, z.categoryId, z.periodType, z.periodKey); if (r.ok) credited++; }
    await logEntry(`Belohnungs-Guthaben gutgeschrieben: +${credited}`);
    return { ok: true, actionType: "credit_reward", label: `+${credited} Guthaben` };
  }
  if (action.action === "deny_orgasm") {
    const res = await denyReward(userId);
    if (!res.ok) return { ok: false, actionType: "deny_orgasm", label: "Orgasmus-Entzug", error: res.error };
    await logEntry(`Orgasmus-Entzug: Belohnungs-Guthaben −1 (neu: ${res.data.available})`);
    return { ok: true, actionType: "deny_orgasm", label: "Orgasmus-Entzug" };
  }
  if (action.action === "delay_orgasm") {
    const hours = typeof action.hours === "number" ? action.hours : 0;
    const res = await delayReward(userId, hours);
    if (!res.ok) return { ok: false, actionType: "delay_orgasm", label: "Orgasmus-Gelegenheit verschieben", error: res.error };
    await logEntry(`Belohnungs-Fenster um ${hours} h verschoben`);
    return { ok: true, actionType: "delay_orgasm", label: `Fenster +${hours} h` };
  }

  return { ok: false, actionType: action.action, label: action.action, error: "Unbekannte Aktion" };
}

// ── Autonomous action (cron) ──────────────────────────────────────────────────

/**
 * Run the autonomous keyholder agent for a single user.
 * Called by the cron endpoint. The agent receives a full overview snapshot,
 * decides whether to act, and optionally creates a task or sends a push.
 */
export async function runAutonomousAction(
  userId: string,
  username: string,
): Promise<{ acted: boolean; summary: string }> {
  const cfg = await getKeyholderConfig(userId);
  if (!cfg?.enabled) return { acted: false, summary: "not enabled" };

  let overviewText = "";
  let autoTagesform: TagesformView | undefined;
  // Zeitzone des Subs für alle Fristen in Push/Chat (Container läuft ohne TZ-Env ⇒ UTC).
  let autoTz = "";
  try {
    const overview = await buildOverview(username);
    autoTagesform = overview.tagesform;
    autoTz = overview.timezone;
    overviewText = `${currentTimeLine(overview.generatedAt, overview.timezone)}\n${rewardStatusLine(overview.belohnung)}\n\n${JSON.stringify(overview, null, 2)}${REWARD_GUIDANCE_TEXT}`;
  } catch (e) {
    return { acted: false, summary: `overview error: ${e}` };
  }

  // Derselbe Kontext wie im Chat: Geräte (inkl. KG-Käfige!), Session-Kategorien, Kontrolle-Cooldown
  // und Tagesform. Der autonome Lauf entscheidet über Anforderungen und Strafen — er darf nicht
  // weniger wissen als der Chat, sonst rät er Namen oder wählt Aktionen, die der Server hart ablehnt.
  // Tagesform aus dem bereits geladenen Overview wiederverwenden (spart die zweite Query).
  const sharedContextText = await buildSharedPromptContext(userId, autoTagesform);

  // Strafbuch — compact summary for the agent (avoid token bloat)
  let strafbuchText = "";
  try {
    const sb = await mcpStrafbuch(username);
    if (sb.detectedOffenseCount > 0) {
      const lines: string[] = [
        `Vergehen gesamt erkannt: ${sb.detectedOffenseCount}, davon offen: ${sb.openOffenseCount}, ausstehende Strafe: ${sb.pendingPenaltyCount}`,
        ...(sb.completionReportCount > 0
          ? [
              `ERLEDIGUNGS-MELDUNGEN (warten auf DEINE Pruefung — Aktion review_strafe):`,
              ...sb.completionReports.map(
                (r) =>
                  `  - refId=${r.ref} | Strafe: ${r.penalty ?? "?"} | gemeldet: ${r.reportedAt}` +
                  `${r.note ? ` | Notiz: ${r.note}` : ""}${r.proofUrl ? " | Nachweis-Foto liegt vor" : " | ohne Nachweis"}`,
              ),
            ]
          : []),
      ];
      for (const o of sb.unauthorizedOpenings)
        lines.push(`- Unerlaubtes Öffnen am ${o.time} (Urteil: ${o.judgment})`);
      for (const o of sb.lateControls)
        lines.push(`- Verspätete Kontrolle (Code ${o.code}, Frist ${o.deadline}, Urteil: ${o.judgment})`);
      for (const o of sb.rejectedControls)
        lines.push(`- Abgelehnte Kontrolle (Code ${o.code}, Urteil: ${o.judgment})`);
      for (const o of sb.lateLocks)
        lines.push(`- Versäumte Verschluss-Anforderung (${o.categoryName ?? "?"}, Frist bis ${o.windowEndedAt}, Urteil: ${o.judgment})`);
      for (const o of sb.wrongDeviceViolations)
        lines.push(`- Falsches Gerät (${o.deviceName ?? "?"}) am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      for (const o of sb.missedOrgasmInstructions)
        lines.push(`- Verpasste Orgasmus-Anweisung (Fenster bis ${o.windowEndedAt}, Urteil: ${o.judgment})`);
      for (const o of sb.missedSessions)
        lines.push(`- Versäumte Session (${o.categoryName ?? "?"}, Frist bis ${o.windowEndedAt}, Urteil: ${o.judgment})`);
      for (const o of sb.erektionViolations)
        lines.push(`- Erektion beim Öffnen (${o.oeffnenGrund ?? "?"}) am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      for (const o of sb.pauseOverageViolations)
        lines.push(`- Pause zu lang (${o.device ?? "?"}/${o.grund ?? "?"}, ${o.dauerMin} Min statt max ${o.maxMin} Min) am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      strafbuchText = `\n\n--- Strafbuch ---\n${lines.join("\n")}${SEVERITY_GUIDANCE_TEXT}`;
    }
  } catch { /* non-fatal */ }

  // Check for ready media to potentially assign
  const readyMedia = await prisma.generatedMedia.findMany({
    where: { userId, status: "ready" },
    orderBy: { createdAt: "asc" },
    take: 5,
  });

  // Proactively queue new media if the ready pool is running low (< 2) and ComfyUI is configured
  if (cfg.mediaEnabled && cfg.comfyUiBaseUrl && readyMedia.length < 2) {
    const pendingCount = await prisma.generatedMedia.count({
      where: { userId, status: { in: ["queued", "generating"] } },
    });
    if (pendingCount === 0) {
      queueMediaGeneration(userId).catch(() => {});  // fire-and-forget
    }
  }

  const mediaList = readyMedia.length > 0
    ? `\n\nVerfügbare Medien zum Zuweisen (${readyMedia.length} bereit):\n` +
      readyMedia.map((m, i) => `[${i}] id=${m.id} type=${m.mediaType}`).join("\n")
    : "";

  // Vision: dieselben relevanten Fotos wie im Chat — die AI beurteilt Nachweise selbst.
  let autoPhotos: KeyholderPhoto[] = [];
  if (cfg.visionEnabled) {
    try {
      autoPhotos = await collectKeyholderPhotos(userId);
    } catch { /* Fotos sind Beiwerk — nie den Lauf kippen lassen */ }
  }

  const agentPrompt: LlmMessage[] = [
    {
      role: "system",
      content:
        buildSystemPrompt(cfg) +
        "\n\nDu führst jetzt eine autonome Überprüfung durch. " +
        "Analysiere den Status des Users und entscheide ob eine Aktion nötig ist. " +
        "Antworte mit einem JSON-Objekt (kein Markdown, nur JSON):\n" +
        '{ "act": boolean, ' +
        '"action": "none"|"send_message"|"assign_media"|"create_kontrolle"|"create_strafe"|"review_strafe"|"create_anforderung"|"create_sperrzeit"|"create_orgasmus"|"set_vorgabe"|"create_wear_anforderung"|"create_session_anforderung"|"grant_reward"|"credit_reward"|"deny_orgasm"|"delay_orgasm", ' +
        '"message": "...", "mediaIndex": 0|null, "kommentar": null|"...", "strafeNotiz": null|"...", ' +
        '"refId": null|string, "entscheidung": null|"bestaetigen"|"ablehnen", "grund": null|string, ' +
        '"fristH": null|number, "dauerH": null|number, "sperrDauerH": null|number, ' +
        '"orgasmusArt": null|"ANWEISUNG"|"GELEGENHEIT", "fensterdauerH": null|number, ' +
        '"orgasmusVorgegebeneArt": null|"Orgasmus"|"ruinierter Orgasmus"|"feuchter Traum", "oeffnenErlaubt": null|boolean, "orgasmusFotoPflicht": null|boolean, ' +
        '"vorgabeTagH": null|number, "vorgabeWocheH": null|number, "vorgabeMonatH": null|number, "vorgabeNotiz": null|string, ' +
        '"wearDeviceName": null|string, "wearDurationH": null|number, "anforderungDeviceName": null|string, "requireCode": null|boolean, ' +
        '"device": null|"CAGE"|"PLUG", ' +
        '"sessionCategoryName": null|string, "sessionDeadlineH": null|number, "sessionRequireVideo": null|boolean, "sessionOrgasmusZiel": null|"KEINE"|"ERFORDERLICH"|"VERBOTEN", "sessionOrgasmusRuiniert": null|boolean, ' +
        '"windowHours": null|number, "category": null|string, "hours": null|number }' +
        "\n\nact=false → keine Aktion nötig.\n" +
        'action="send_message" → sende dem User eine Nachricht (message Feld).\n' +
        'action="assign_media" → weise ein Medienelement als Aufgabe zu (mediaIndex + message).\n' +
        'action="create_kontrolle" → fordere eine Foto-Kontrolle an (nur wenn User VERSCHLOSSEN ist). ' +
        'kommentar = Anweisung für den User. device="CAGE" (Keuschheitsgürtel, Standard) oder "PLUG" (Plug). ' +
        'requireCode=true (Standard): sendet Zufalls-Code per E-Mail. ' +
        'requireCode=false: nur Foto-Nachweis ohne Code (sinnvoll wenn lock.hasKontrollCode=false). Sendet E-Mail + Push automatisch.\n' +
        'action="create_strafe" → verhänge eine Strafe im Strafbuch (strafeNotiz = kurze Begründung, message = Chat-Text). ' +
        'Nur bei klaren Regelverstößen verwenden. Beachte das Strafbuch: bereits beurteilte Vergehen nicht nochmals bestrafen.\n' +
        'action="review_strafe" → prüfe eine vom Sub GEMELDETE Erledigung (siehe ERLEDIGUNGS-MELDUNGEN im Status). ' +
        'refId = exakt die gemeldete refId. entscheidung="bestaetigen" (Strafe abgehakt) oder "ablehnen" (Strafe bleibt offen; grund ist dann PFLICHT und wird dem Sub angezeigt). ' +
        'Liegt ein Nachweis-Foto vor, ist es dieser Anfrage als Bild ANGEHÄNGT (siehe „Angehängte Fotos“) — sieh es dir an und urteile danach. message = Chat-Text.\n' +
        'action="create_anforderung" → fordere den User auf, sich einzuschliessen (nur wenn User OFFEN ist). ' +
        'fristH = Stunden bis zur Frist (z.B. 2), dauerH = Mindest-Tragedauer in Stunden (optional), anforderungDeviceName = EXAKTER KG-Käfig-Name aus der Geräteliste (dann ist das Erfass-Formular fest auf dieses Gerät begrenzt), message = Nachricht im Chat.\n' +
        'action="create_sperrzeit" → setze eine Sperrzeit (User darf sich nicht öffnen), nur wenn User VERSCHLOSSEN ist. ' +
        'sperrDauerH = Dauer in Stunden (z.B. 12), message = Nachricht im Chat.\n' +
        'action="create_orgasmus" → erteile dem User eine Orgasmus-Anweisung oder -Gelegenheit. ' +
        'orgasmusArt="ANWEISUNG" (User MUSS Orgasmus erfassen) oder "GELEGENHEIT" (User DARF). ' +
        'fensterdauerH = Zeitfenster in Stunden (z.B. 4). ' +
        'orgasmusVorgegebeneArt = erforderliche Art — EXAKT ein Wert aus der Orgasmus-Arten-Liste des Users (z.B. "ruinierter Orgasmus", "Orgasmus", "feuchter Traum") oder null für beliebig. ' +
        'oeffnenErlaubt = true wenn User sich dafür öffnen darf ohne Strafe, false wenn er verschlossen bleiben muss (z.B. ruinierter Orgasmus als Strafe). ' +
        'oeffnenErlaubt=false NUR wenn lock.isLocked===true. Ist der User NICHT verschlossen (lock.isLocked===false), setze IMMER oeffnenErlaubt=true — "verschlossen bleiben" ist ohne angelegten Käfig sinnlos. ' +
        'Wenn User VERSCHLOSSEN ist: setze oeffnenErlaubt=false und orgasmusVorgegebeneArt="ruinierter Orgasmus" für einen ruinierten Orgasmus als Strafe. ' +
        'orgasmusFotoPflicht = true verlangt beim Erfassen ein Foto (serverseitig erzwungen); false/null = Foto freiwillig. Erfasste Fotos bekommst du als Bild angehängt. ' +
        'message = Nachricht im Chat.\n' +
        'action="set_vorgabe" → setze oder ändere die Trage-Trainingsvorgabe des Users (Mindeststunden). ' +
        'vorgabeTagH/vorgabeWocheH/vorgabeMonatH = Mindeststunden pro Periode (mind. einer muss gesetzt sein). ' +
        'vorgabeNotiz = kurze Begründung (z.B. "Intensivierungsphase"). message = Chat-Text.\n' +
        'action="create_wear_anforderung" → erstellt eine offizielle Trage-Anforderung für ein Non-KG-Gerät (Plug, etc.); der User bekommt Push/E-Mail und muss es in der App bestätigen. ' +
        'wearDeviceName = exakter Gerätename aus der Geräteliste (muss exakt übereinstimmen). wearDurationH = Frist in Stunden. message = kurze Erklärung im Chat.\n' +
        'action="create_session_anforderung" → fordere den User auf, eine Trainings-Session in einer Session-Kategorie zu starten. ' +
        'sessionCategoryName = exakter Name aus der Session-Kategorien-Liste. sessionDeadlineH = Frist in Stunden (null = keine). ' +
        'sessionRequireVideo = Video-/Foto-Nachweis beim Session-Ende. sessionOrgasmusZiel = Orgasmus erforderlich/verboten/kein Ziel. sessionOrgasmusRuiniert = nur bei ERFORDERLICH: muss ruiniert sein. message = Anweisung im Chat.\n' +
        'action="grant_reward" → löse eine verdiente Belohnung ein: öffnet ein Belohnungs-Fenster und bucht 1 vom Guthaben belohnung.available ab (≥1 nötig, kein aktives Fenster). windowHours = Fensterdauer (Standard 24).\n' +
        'action="credit_reward" → schreibe für erreichte, noch nicht gutgeschriebene Ziele (belohnung.rewardableGoals) Guthaben gut (Standard: 1 pro Aufruf; all=true = alle auf einmal). category = optional auf eine Kategorie beschränken (leer = KG).\n' +
        'action="deny_orgasm" → Strafe: Belohnungs-Guthaben −1 (nicht bei Stand 0).\n' +
        'action="delay_orgasm" → Strafe: aktives Belohnungs-Fenster um hours Stunden schieben.\n\n' +
        'PFLICHT-CONSTRAINTS (NIEMALS ignorieren):\n' +
        '- create_anforderung NUR wenn lock.isLocked === false\n' +
        '- create_sperrzeit NUR wenn lock.isLocked === true\n' +
        '- create_kontrolle NUR wenn lock.isLocked === true\n' +
        '  Wenn lock.hasKontrollCode === false: requireCode=false setzen (nur Foto-Nachweis, kein Code)\n' +
        '  Wenn lock.hasKontrollCode === true: requireCode=true (Standard, Siegel-Nummer + Code wird geprüft)\n' +
        '- NUR EINE action pro Run. Wenn du mehrere Dinge tun willst, wähle jetzt die wichtigste.\n' +
        '- Plug/Device tragen ankündigen ohne create_wear_anforderung = wirkungslos. Immer action setzen.\n' +
        '- KÖRPERREGION-EXKLUSIVITÄT: Käfig = GENITAL; Anal-Plug UND Dildo-/Anal-Sessions = ANAL (dieselbe Öffnung). NIEMALS zwei Geräte derselben Region gleichzeitig fordern — kein Plug UND Anal-/Dildo-Session zusammen (körperlich unmöglich). Käfig + Anal-Session ist ok. Vor einer Anal-Session/Plug-Anforderung: prüfe activeWearSessions; wird schon ein Plug getragen, keine zweite Anal-Aufgabe stellen. CAGE (genital) und PLUG (anal) nie verwechseln.\n' +
        '- ERFÜLLUNG AM STATUS ABLESEN (activeWearSessions/Anforderungen), nicht am Chat-Text. Zeigt der Tracker das Gerät als getragen, erkenne es an; behauptet es der User ohne Tracker-Beleg, bitte ihn es in der App zu starten.\n' +
        '- GESUNDHEITS-STOPP: Ist healthHold aktiv (der Sub hat selbst eine Pause signalisiert), stelle KEINE neuen Anforderungen und verhänge KEINE Strafen. Erlaubt sind nur send_message (fürsorglich, frage nach dem Befinden) sowie credit_reward/grant_reward. Fordernde Aktionen werden serverseitig hart blockiert.\n' +
        'Verstoss gegen diese Regeln erzeugt einen Fehler und keine Aktion wird ausgeführt.',
    },
    {
      role: "user",
      content: `Aktueller Status:\n${overviewText}${sharedContextText}${strafbuchText}${mediaList}${photoPromptSection(autoPhotos)}`,
    },
  ];
  const agentMessages = attachPhotos(agentPrompt, autoPhotos);

  let raw = "";
  try {
    raw = await llmChat(toLlmConfig(cfg), agentMessages);
    // Strip markdown code fences if present
    raw = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const decision = JSON.parse(raw) as {
      act: boolean;
      action: string;
      message: string;
      mediaIndex: number | null;
      kommentar?: string | null;
      strafeNotiz?: string | null;
      // review_strafe: gemeldete Erledigung prüfen
      refId?: string | null;
      entscheidung?: "bestaetigen" | "ablehnen" | null;
      grund?: string | null;
      fristH?: number | null;
      dauerH?: number | null;
      sperrDauerH?: number | null;
      orgasmusArt?: "ANWEISUNG" | "GELEGENHEIT" | null;
      fensterdauerH?: number | null;
      orgasmusVorgegebeneArt?: string | null;
      orgasmusFotoPflicht?: boolean | null;
      oeffnenErlaubt?: boolean | null;
      vorgabeTagH?: number | null;
      vorgabeWocheH?: number | null;
      vorgabeMonatH?: number | null;
      vorgabeNotiz?: string | null;
      wearDeviceName?: string | null;
      wearDurationH?: number | null;
      anforderungDeviceName?: string | null;
      requireCode?: boolean;
      device?: "CAGE" | "PLUG" | null;
      sessionCategoryName?: string | null;
      sessionDeadlineH?: number | null;
      sessionRequireVideo?: boolean | null;
      sessionOrgasmusZiel?: "KEINE" | "ERFORDERLICH" | "VERBOTEN" | null;
      sessionOrgasmusRuiniert?: boolean | null;
      windowHours?: number | null;
      category?: string | null;
      hours?: number | null;
      all?: boolean | null;
    };

    if (!decision.act) {
      await prisma.aiKeyholderConfig.update({
        where: { userId },
        data: { lastRunAt: new Date() },
      });
      return { acted: false, summary: "agent decided: no action" };
    }

    // ── Gesundheits-Stopp: harte Sperre auch im autonomen Lauf (Fürsorge geht vor) ──
    if (HEALTH_HOLD_BLOCKED_ACTIONS.has(decision.action) && (await isHealthHoldActive(userId))) {
      await prisma.aiKeyholderMessage.create({
        data: { userId, role: "system", content: `[Autonome Prüfung] [Gesundheits-Stopp] Aktion „${decision.action}" blockiert — der Sub hat eine Pause signalisiert.` },
      });
      await prisma.aiKeyholderConfig.update({ where: { userId }, data: { lastRunAt: new Date() } });
      return { acted: false, summary: "blocked: health hold active" };
    }

    // Log as system message (context for future chats, not shown in UI)
    await prisma.aiKeyholderMessage.create({
      data: {
        userId,
        role: "system",
        content: `[Autonome Prüfung] ${decision.message}`,
      },
    });

    if (decision.action === "assign_media" && decision.mediaIndex != null) {
      const media = readyMedia[decision.mediaIndex];
      if (media) {
        // Assign existing ready media as task
        await prisma.keyholderTask.create({
          data: {
            userId,
            type: "VIEW_MEDIA",
            message: decision.message,
            mediaId: media.id,
            dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        await prisma.generatedMedia.update({
          where: { id: media.id },
          data: { status: "assigned", assignedAt: new Date() },
        });
        await sendPushToUser(
          userId,
          "Neue Aufgabe von deiner Keyholderin",
          decision.message.slice(0, 100),
          "/dashboard/keyholder",
        );
      } else if (cfg.mediaEnabled && cfg.comfyUiBaseUrl) {
        // No ready media — queue a new generation and fall back to message
        try {
          await queueMediaGeneration(userId);
          await processQueuedJobs(1);
        } catch {
          // Non-fatal — generation will be picked up by the poll cron
        }
        // Still deliver the message so the user gets something now
        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "assistant", content: decision.message },
        });
        await sendPushToUser(
          userId,
          "Nachricht von deiner Keyholderin",
          decision.message.slice(0, 100),
          "/dashboard/keyholder",
        );
      }
    } else if (decision.action === "create_kontrolle") {
      {
        // Rate-limit: max. 1 Kontrolle pro 60 Minuten — per Device (CAGE / PLUG unabhängig)
        const autoDevice = typeof decision.device === "string" && ["CAGE", "PLUG"].includes(decision.device)
          ? decision.device as "CAGE" | "PLUG"
          : "CAGE"; // default
        const lastKon = await prisma.kontrollAnforderung.findFirst({
          where: { userId, device: autoDevice },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        if (lastKon && (Date.now() - lastKon.createdAt.getTime()) / 60000 < 60) {
          await prisma.aiKeyholderMessage.create({
            data: { userId, role: "system", content: `[Autonome Prüfung] Kontrolle (${autoDevice}) abgelehnt: Cooldown aktiv (60 Min. zwischen Kontrollen pro Device)` },
          });
        } else {
        const requireCode = decision.requireCode !== false; // default true
        const result = await requestKontrolle({
          userId,
          kommentar: decision.kommentar ?? decision.message ?? null,
          deadlineH: 4,
          requireCode,
          device: autoDevice,
        });

        const eventText = result.ok
          ? `[Kontrolle] ${decision.message ?? "Foto-Kontrolle angefordert."} (Frist: ${formatDateTime(result.data.deadline, "de-CH", autoTz)})`
          : `[Kontrolle] Kontrolle konnte nicht erstellt werden: ${result.error}`;

        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "system", content: `[Autonome Prüfung] ${eventText}` },
        });

        if (!result.ok) {
          await prisma.aiKeyholderMessage.create({
            data: { userId, role: "assistant", content: decision.message ?? "Ich wollte eine Kontrolle anfordern, aber der aktuelle Status lässt das nicht zu." },
          });
        }
        // Push is already sent by requestKontrolle when result.ok
        } // end else (cooldown check)
      }

    } else if (decision.action === "create_strafe") {
      // Log a penalty record
      const notiz = decision.strafeNotiz ?? decision.message ?? "Autonome KI-Strafe";
      const refId = `aikh-${userId}-${Date.now()}`;

      await prisma.strafeRecord.create({
        data: {
          userId,
          offenseType: "AI_KEYHOLDER",
          refId,
          bestraftDatum: new Date(),
          notiz,
          // reason = Straftext (wie beim Urteil) → Sub-Ansicht und Strafbuch zeigen ihn an.
          reason: notiz,
          judgedBy: "ai",
        },
      });

      const eventText = `[Strafe] ${notiz}`;
      await prisma.aiKeyholderMessage.create({
        data: { userId, role: "system", content: `[Autonome Prüfung] ${eventText}` },
      });

      await sendPushToUser(
        userId,
        "Strafe von deiner Keyholderin",
        notiz.slice(0, 100),
        "/dashboard/keyholder",
      );

    } else if (decision.action === "review_strafe") {
      // Vom Sub gemeldete Erledigung prüfen: bestätigen (abhaken) oder mit Begründung ablehnen.
      const refId = decision.refId?.trim() ?? "";
      const ablehnen = decision.entscheidung === "ablehnen";
      const res = !refId
        ? { ok: false as const, status: 400, error: "Kein refId" }
        : ablehnen
          ? await lehneErledigungAb(userId, refId, decision.grund ?? "")
          : await bestaetigeErledigung(userId, refId);

      await prisma.aiKeyholderMessage.create({
        data: {
          userId, role: "system",
          content: res.ok
            ? `[Autonome Prüfung] [Erledigung] ${ablehnen ? `Abgelehnt: ${decision.grund ?? ""}` : "Bestätigt"}`
            : `[Autonome Prüfung] [Erledigung] Fehlgeschlagen: ${res.error}`,
        },
      });

    } else if (decision.action === "create_anforderung") {
      // Pre-check: user must be OPEN — service also validates but we guard early to avoid noisy fallback messages
      const lockEntry = await prisma.entry.findFirst({
        where: { userId, type: { in: ["VERSCHLUSS", "OEFFNEN"] } },
        orderBy: { startTime: "desc" },
      });
      const userIsLocked = lockEntry?.type === "VERSCHLUSS";

      if (userIsLocked) {
        // AI made a wrong-state decision — log silently, no user message (would be confusing)
        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "system", content: "[Autonome Prüfung] [Anforderung] Übersprungen: User ist bereits verschlossen (KI-Entscheid korrigiert)." },
        });
      } else {
        const fristH = typeof decision.fristH === "number" && decision.fristH > 0
          ? decision.fristH
          : 2; // sensible default: 2 hours
        const dauerH = typeof decision.dauerH === "number" && decision.dauerH > 0
          ? decision.dauerH
          : undefined;

        const anfDeviceName = decision.anforderungDeviceName?.trim() || null;
        const anfDeviceId = anfDeviceName ? (await resolveDeviceLoose(userId, anfDeviceName, "kg"))?.id : undefined;

        const result = await createVerschlussAnforderung({
          userId,
          art: "ANFORDERUNG",
          nachricht: decision.message ?? null,
          fristH,
          dauerH: dauerH ?? null,
          deviceId: anfDeviceId,
        });

        const eventText = result.ok
          ? `[Anforderung] ${decision.message ?? "Einschluss angefordert."} (Frist: ${fristH}h${dauerH ? `, Mindestdauer: ${dauerH}h` : ""})`
          : `[Anforderung] Anforderung fehlgeschlagen: ${result.error}`;

        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "system", content: `[Autonome Prüfung] ${eventText}` },
        });

        if (result.ok && decision.message) {
          await prisma.aiKeyholderMessage.create({
            data: { userId, role: "assistant", content: decision.message },
          });
        }
      }

    } else if (decision.action === "create_sperrzeit") {
      // Pre-check: user must be LOCKED
      const lockEntry = await prisma.entry.findFirst({
        where: { userId, type: { in: ["VERSCHLUSS", "OEFFNEN"] } },
        orderBy: { startTime: "desc" },
      });
      const userIsLocked = lockEntry?.type === "VERSCHLUSS";

      if (!userIsLocked) {
        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "system", content: "[Autonome Prüfung] [Sperrzeit] Übersprungen: User ist nicht verschlossen (KI-Entscheid korrigiert)." },
        });
      } else {
        const sperrDauerH = typeof decision.sperrDauerH === "number" && decision.sperrDauerH > 0
          ? decision.sperrDauerH
          : 8; // sensible default: 8 hours

        const result = await createVerschlussAnforderung({
          userId,
          art: "SPERRZEIT",
          nachricht: decision.message ?? null,
          fristH: sperrDauerH,
        });

        const eventText = result.ok
          ? `[Sperrzeit] ${decision.message ?? "Sperrzeit gesetzt."} (Dauer: ${sperrDauerH}h)`
          : `[Sperrzeit] Sperrzeit fehlgeschlagen: ${result.error}`;

        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "system", content: `[Autonome Prüfung] ${eventText}` },
        });

        if (result.ok && decision.message) {
          await prisma.aiKeyholderMessage.create({
            data: { userId, role: "assistant", content: decision.message },
          });
        }
      }

    } else if (decision.action === "create_orgasmus") {
      // Grant/assign an orgasm directive (Anweisung) or opportunity (Gelegenheit)
      const art = decision.orgasmusArt === "ANWEISUNG" || decision.orgasmusArt === "GELEGENHEIT"
        ? decision.orgasmusArt
        : "GELEGENHEIT"; // sensible default
      const fensterdauerH = typeof decision.fensterdauerH === "number" && decision.fensterdauerH > 0
        ? decision.fensterdauerH
        : 4; // sensible default: 4 hours

      const beginntAt = new Date();
      const endetAt = new Date(beginntAt.getTime() + fensterdauerH * 60 * 60 * 1000);

      // "Verschlossen bleiben" nur sinnvoll bei tatsächlich verschlossenem User — sonst oeffnenErlaubt=true.
      const isLockedNow = await getIsLocked(userId);
      const result = await createOrgasmusAnforderung({
        userId,
        art,
        nachricht: decision.message ?? null,
        beginntAt,
        endetAt,
        vorgegebeneArt: decision.orgasmusVorgegebeneArt ?? null,
        oeffnenErlaubt: !isLockedNow ? true : decision.oeffnenErlaubt === true,
        fotoPflicht: decision.orgasmusFotoPflicht === true,
      });

      const artLabel = art === "ANWEISUNG" ? "Anweisung" : "Gelegenheit";
      const eventText = result.ok
        ? `[Orgasmus-${artLabel}] ${decision.message ?? `${artLabel} erteilt.`} (Fenster: ${fensterdauerH}h)`
        : `[Orgasmus-${artLabel}] Konnte nicht erstellt werden: ${result.error}`;

      await prisma.aiKeyholderMessage.create({
        data: { userId, role: "system", content: `[Autonome Prüfung] ${eventText}` },
      });

      if (result.ok && decision.message) {
        // createOrgasmusAnforderung already sends email + push — just add chat message
        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "assistant", content: decision.message },
        });
      } else if (!result.ok) {
        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "assistant", content: decision.message ?? `Ich wollte dir eine Orgasmus-${artLabel} geben, aber es gab ein Problem.` },
        });
      }

    } else if (decision.action === "set_vorgabe") {
      const tagH = typeof decision.vorgabeTagH === "number" && decision.vorgabeTagH > 0 ? decision.vorgabeTagH : null;
      const wocheH = typeof decision.vorgabeWocheH === "number" && decision.vorgabeWocheH > 0 ? decision.vorgabeWocheH : null;
      const monatH = typeof decision.vorgabeMonatH === "number" && decision.vorgabeMonatH > 0 ? decision.vorgabeMonatH : null;

      if (!tagH && !wocheH && !monatH) {
        // No valid targets — fall back to message
        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "assistant", content: decision.message ?? "Ich wollte eine Trainingsvorgabe setzen, aber keine gültigen Werte angegeben." },
        });
      } else {
        const notiz = decision.vorgabeNotiz ?? null;
        const result = await createVorgabe({
          userId,
          gueltigAb: new Date(),
          minProTagH: tagH,
          minProWocheH: wocheH,
          minProMonatH: monatH,
          notiz,
        });

        const partsLabel = [
          tagH ? `${tagH}h/Tag` : null,
          wocheH ? `${wocheH}h/Woche` : null,
          monatH ? `${monatH}h/Monat` : null,
        ].filter(Boolean).join(", ");
        const eventText = result.ok
          ? `[Vorgabe] ${partsLabel}${notiz ? ` – ${notiz}` : ""}`
          : `[Vorgabe] Konnte nicht gesetzt werden: ${result.error}`;

        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "system", content: `[Autonome Prüfung] ${eventText}` },
        });

        if (result.ok && decision.message) {
          await prisma.aiKeyholderMessage.create({
            data: { userId, role: "assistant", content: decision.message },
          });
          await sendPushToUser(
            userId,
            "Neue Trainingsvorgabe",
            decision.message.slice(0, 100),
            "/dashboard/keyholder",
          );
        } else if (!result.ok) {
          await prisma.aiKeyholderMessage.create({
            data: { userId, role: "assistant", content: decision.message ?? "Ich wollte deine Trainingsvorgabe anpassen, aber es gab ein Problem." },
          });
        }
      }

    } else if (decision.action === "create_wear_anforderung" && decision.wearDeviceName) {
      const durationH = typeof decision.wearDurationH === "number" && decision.wearDurationH > 0
        ? decision.wearDurationH
        : 2;
      const deviceName = decision.wearDeviceName as string;
      const device = await resolveDeviceLoose(userId, deviceName);
      const wearConflict = device?.categoryId ? await findRegionConflict(userId, device.categoryId, { includeOpenRequests: true }) : null;
      if (device?.categoryId && !wearConflict) {
        const nachricht = decision.message ?? `Trage ${deviceName} für ${durationH} Stunden.`;
        await createVerschlussAnforderung({ userId, art: "ANFORDERUNG", deviceCategoryId: device.categoryId, deviceId: device.id, nachricht, fristH: durationH });
      }
      const eventText = wearConflict
        ? `[Wear-Anforderung] Übersprungen: Körperregion-Konflikt mit „${wearConflict.blockingCategoryName}".`
        : `[Wear-Anforderung] ${deviceName} für ${durationH}h`;
      await prisma.aiKeyholderMessage.create({
        data: { userId, role: "system", content: `[Autonome Prüfung] ${eventText}` },
      });
      if (decision.message) {
        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "assistant", content: decision.message },
        });
      }

    } else if (decision.action === "create_session_anforderung" && decision.sessionCategoryName) {
      const categoryName = decision.sessionCategoryName.trim();
      const category = await prisma.deviceCategory.findFirst({
        where: { userId, name: categoryName, isSessionCategory: true },
        select: { id: true, name: true },
      });

      const sessRegionConflict = category ? await findRegionConflict(userId, category.id, { includeOpenRequests: true }) : null;
      if (!category) {
        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "system", content: `[Autonome Prüfung] [Session-Anforderung] Übersprungen: Session-Kategorie "${categoryName}" nicht gefunden.` },
        });
      } else if (sessRegionConflict) {
        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "system", content: `[Autonome Prüfung] [Session-Anforderung] Übersprungen: Körperregion-Konflikt mit „${sessRegionConflict.blockingCategoryName}".` },
        });
      } else {
        const deadlineH = typeof decision.sessionDeadlineH === "number" && decision.sessionDeadlineH > 0
          ? decision.sessionDeadlineH
          : null;
        const endetAt = deadlineH ? new Date(Date.now() + deadlineH * 60 * 60 * 1000) : null;
        const sOrgZiel = typeof decision.sessionOrgasmusZiel === "string" && ["KEINE", "ERFORDERLICH", "VERBOTEN"].includes(decision.sessionOrgasmusZiel) ? decision.sessionOrgasmusZiel : "KEINE";
        const sRuiniert = sOrgZiel === "ERFORDERLICH" && Boolean(decision.sessionOrgasmusRuiniert);

        await prisma.sessionAnforderung.create({
          data: { userId, deviceCategoryId: category.id, nachricht: decision.message ?? null, endetAt, requireVideo: Boolean(decision.sessionRequireVideo), orgasmusZiel: sOrgZiel, orgasmusRuiniert: sRuiniert },
        });

        const eventText = `[Session-Anforderung] ${decision.message ?? `Session mit ${category.name} gefordert.`}${deadlineH ? ` (Frist: ${deadlineH}h)` : ""}`;
        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "system", content: `[Autonome Prüfung] ${eventText}` },
        });

        if (decision.message) {
          await prisma.aiKeyholderMessage.create({
            data: { userId, role: "assistant", content: decision.message },
          });
        }

        const pushBody = decision.message ?? `Session mit ${category.name} gefordert${endetAt ? ` (bis ${formatTime(endetAt, "de-DE", autoTz)})` : ""}`;
        await sendPushToUser(userId, "Session-Anforderung", pushBody.slice(0, 100), "/dashboard/new/session-begin");
      }

    } else if (decision.action === "grant_reward") {
      const windowH = typeof decision.windowHours === "number" && decision.windowHours > 0 ? decision.windowHours : undefined;
      const res = await grantBelohnung(userId, windowH, true);
      const eventText = res.ok ? `[Belohnung] gewährt (Guthaben: ${res.data.available})` : `[Belohnung] fehlgeschlagen: ${res.error}`;
      await prisma.aiKeyholderMessage.create({ data: { userId, role: "system", content: `[Autonome Prüfung] ${eventText}` } });
      if (decision.message) await prisma.aiKeyholderMessage.create({ data: { userId, role: "assistant", content: decision.message } });

    } else if (decision.action === "credit_reward") {
      const belohnbar = await computeBelohnbar(userId);
      const filter = typeof decision.category === "string" ? decision.category.trim().toLowerCase() : null;
      const matched = filter ? belohnbar.filter((b) => b.categoryName.toLowerCase() === filter) : belohnbar;
      const targets = decision.all ? matched : matched.slice(0, 1);
      let credited = 0;
      for (const z of targets) { const r = await grantGutschrift(userId, z.categoryId, z.periodType, z.periodKey); if (r.ok) credited++; }
      await prisma.aiKeyholderMessage.create({ data: { userId, role: "system", content: `[Autonome Prüfung] [Belohnung] gutgeschrieben: +${credited}` } });
      if (decision.message) await prisma.aiKeyholderMessage.create({ data: { userId, role: "assistant", content: decision.message } });

    } else if (decision.action === "deny_orgasm") {
      const res = await denyReward(userId);
      const eventText = res.ok ? `[Orgasmus-Entzug] Guthaben −1 (neu: ${res.data.available})` : `[Orgasmus-Entzug] fehlgeschlagen: ${res.error}`;
      await prisma.aiKeyholderMessage.create({ data: { userId, role: "system", content: `[Autonome Prüfung] ${eventText}` } });
      if (decision.message) await prisma.aiKeyholderMessage.create({ data: { userId, role: "assistant", content: decision.message } });

    } else if (decision.action === "delay_orgasm") {
      const hours = typeof decision.hours === "number" ? decision.hours : 0;
      const res = await delayReward(userId, hours);
      const eventText = res.ok ? `[Orgasmus-Fenster] um ${hours}h verschoben` : `[Orgasmus-Fenster] verschieben fehlgeschlagen: ${res.error}`;
      await prisma.aiKeyholderMessage.create({ data: { userId, role: "system", content: `[Autonome Prüfung] ${eventText}` } });
      if (decision.message) await prisma.aiKeyholderMessage.create({ data: { userId, role: "assistant", content: decision.message } });

    } else if (decision.action === "send_message" && decision.message) {
      // Create an assistant message visible in chat
      await prisma.aiKeyholderMessage.create({
        data: { userId, role: "assistant", content: decision.message },
      });
      await sendPushToUser(
        userId,
        "Nachricht von deiner Keyholderin",
        decision.message.slice(0, 100),
        "/dashboard/keyholder",
      );
    }

    await prisma.aiKeyholderConfig.update({
      where: { userId },
      data: { lastRunAt: new Date() },
    });

    return { acted: true, summary: decision.message };
  } catch (e) {
    return { acted: false, summary: `parse/action error: ${e} — raw: ${raw}` };
  }
}

// ── Task completion ───────────────────────────────────────────────────────────

/**
 * User completes a task by submitting their response text.
 * The keyholder AI reacts to the response and the reaction is stored on the task.
 */
export async function completeTask(
  userId: string,
  username: string,
  taskId: string,
  responseText: string,
): Promise<{ aiReactionText: string }> {
  const task = await prisma.keyholderTask.findFirst({
    where: { id: taskId, userId, completedAt: null },
  });
  if (!task) throw new Error("Aufgabe nicht gefunden oder bereits abgeschlossen.");

  const cfg = await getKeyholderConfig(userId);
  if (!cfg?.enabled) throw new Error("AI Keyholder ist nicht aktiviert.");

  // Fetch current overview so the AI reaction is grounded in actual state
  // (prevents hallucinating e.g. "du trägst den Plug" from the task description alone)
  let overviewSnippet = "";
  try {
    const ov = await buildOverview(username);
    const activeWear = ov.activeWearSessions ?? [];
    overviewSnippet = `\n${currentTimeLine(ov.generatedAt, ov.timezone)}` + (activeWear.length > 0
      ? `\nAktuell aktive Tragesessionen: ${activeWear.map((s: { category: string; deviceName: string }) => `${s.deviceName} (${s.category})`).join(", ")}.`
      : "\nAktuell keine aktiven Tragesessionen (kein Gerät wird gerade getragen).");
  } catch {
    // non-fatal
  }

  const taskTagesformText = await buildTagesformContext(userId);

  const reactionMessages: LlmMessage[] = [
    {
      role: "system",
      content:
        buildSystemPrompt(cfg) +
        "\n\nDer User hat soeben eine Aufgabe abgeschlossen. Reagiere kurz und in der Rolle der Keyholderin." +
        overviewSnippet +
        taskTagesformText,
    },
    {
      role: "user",
      content: `Aufgabe: "${task.message}"\n\nAntwort des Users: "${responseText}"`,
    },
  ];

  const aiReactionText = await llmChat(toLlmConfig(cfg), reactionMessages);

  await prisma.keyholderTask.update({
    where: { id: taskId },
    data: {
      completedAt: new Date(),
      responseText,
      aiReactionText,
    },
  });

  // Add reaction as assistant message in chat history
  await prisma.aiKeyholderMessage.create({
    data: { userId, role: "assistant", content: aiReactionText },
  });

  return { aiReactionText };
}

// ── Event-driven reaction ─────────────────────────────────────────────────────

/** Human-readable label for each entry type shown to the AI. */
const EVENT_LABELS: Record<string, string> = {
  VERSCHLUSS: "hat sich eingeschlossen",
  OEFFNEN: "hat sich geöffnet",
  PRUEFUNG: "hat eine Kontrolle eingereicht",
  ORGASMUS: "hat einen Orgasmus erfasst",
  WEAR_BEGIN: "hat ein Gerät angelegt",
  WEAR_END: "hat ein Gerät abgelegt",
  SESSION_BEGIN: "hat eine Trainings-Session gestartet",
  SESSION_END: "hat eine Trainings-Session beendet",
  PAUSE_BEGIN: "hat eine Pause begonnen (Gerät kurz abgenommen)",
  PAUSE_END: "hat eine Pause beendet (Gerät wieder angelegt)",
};

/**
 * Fire-and-forget: the AI reacts to a sub's entry event with a short push + chat message.
 * Called from POST /api/entries after the entry is persisted.
 * Must NOT be awaited in the API route — it runs in the background.
 */
export async function reactToSubEvent(
  userId: string,
  username: string,
  entryType: string,
  entryNote: string | null,
  entryImageUrl?: string | null,
): Promise<void> {
  try {
    const cfg = await getKeyholderConfig(userId);
    if (!cfg?.enabled) return;

    // Vision: das Foto DIESES Eintrags mitschicken — die Sofort-Reaktion soll sich auf das beziehen,
    // was der Sub gerade hochgeladen hat (sonst reagiert sie blind auf ein Bild, das vor ihr liegt).
    let eventPhoto: KeyholderPhoto | null = null;
    if (cfg.visionEnabled && entryImageUrl) {
      try {
        const img = await loadUploadImage(entryImageUrl, { maxPx: 768, quality: 75 });
        if (img) {
          eventPhoto = {
            label: `${EVENT_LABELS[entryType] ?? entryType} — soeben erfasstes Foto`,
            imageUrl: entryImageUrl,
            mediaType: img.mediaType,
            base64: img.base64,
          };
        }
      } catch { /* Foto ist Beiwerk — die Reaktion darf daran nicht scheitern */ }
    }

    // Build a compact overview for context (non-fatal if it fails)
    let overviewText = "";
    try {
      const overview = await buildOverview(username);
      overviewText = `${currentTimeLine(overview.generatedAt, overview.timezone)}\n${rewardStatusLine(overview.belohnung)}\n\n${JSON.stringify(overview, null, 2)}`;
    } catch { /* non-fatal */ }

    // Tagesform: auch die Sofort-Reaktion muss die Selbsteinschätzung kennen — sonst fordert sie
    // sie an ("teile mir deine Tagesform mit"), obwohl der User sie längst im Dashboard erfasst hat.
    const eventTagesformText = await buildTagesformContext(userId);

    const eventLabel = EVENT_LABELS[entryType] ?? `hat einen Eintrag vom Typ ${entryType} erstellt`;
    const noteHint = entryNote ? ` Notiz: "${entryNote}"` : "";

    const reactionMessages: LlmMessage[] = [
      {
        role: "system",
        content:
          buildSystemPrompt(cfg) +
          "\n\nDu reagierst jetzt kurz auf ein Ereignis des Users. " +
          "Antworte in 1–2 Sätzen, in der Rolle der Keyholderin. Kein Markdown. " +
          "Sei direkt, bestimmt und passend zum Ereignis. " +
          "Wenn das Ereignis ungewöhnlich oder gegen Regeln ist, reagiere entsprechend streng." +
          eventTagesformText,
      },
      {
        role: "user",
        content:
          `Aktuelles Ereignis: ${username} ${eventLabel}.${noteHint}` +
          (eventPhoto
            ? "\n\nDer Eintrag hat ein Foto — es ist dieser Nachricht ANGEHÄNGT. Sieh es dir an und beziehe dich konkret darauf: was ist zu sehen, wirkt es stimmig zum Eintrag?"
            : "") +
          `\n\nStatus:\n${overviewText}`,
      },
    ];

    const reactionText = await llmChat(
      toLlmConfig(cfg),
      attachPhotos(reactionMessages, eventPhoto ? [eventPhoto] : []),
    );
    if (!reactionText?.trim()) return;

    // Save as assistant message (visible in chat)
    await prisma.aiKeyholderMessage.create({
      data: { userId, role: "assistant", content: reactionText.trim() },
    });

    // Push notification — only for relevant event types (not WEAR_BEGIN/END to avoid noise)
    if (["VERSCHLUSS", "OEFFNEN", "PRUEFUNG", "ORGASMUS"].includes(entryType)) {
      await sendPushToUser(
        userId,
        "Reaktion deiner Keyholderin",
        reactionText.trim().slice(0, 100),
        "/dashboard/keyholder",
      );
    }
  } catch {
    // Non-fatal — entry was already saved; AI reaction is best-effort
  }
}
