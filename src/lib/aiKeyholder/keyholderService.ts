import { prisma } from "@/lib/prisma";
import { buildOverview, mcpStrafbuch } from "@/lib/mcpOverview";
import { sendPushToUser } from "@/lib/push";
import { llmChat, llmStream, type LlmConfig, type LlmMessage } from "./llmClient";
import { queueMediaGeneration, processQueuedJobs } from "./mediaQueue";
import { requestKontrolle } from "@/lib/kontrolleService";
import { createVerschlussAnforderung } from "@/lib/verschlussAnforderungService";
import { createOrgasmusAnforderung } from "@/lib/orgasmusAnforderungService";
import { createVorgabe } from "@/lib/vorgabeService";
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

export function buildSystemPrompt(cfg: AiKeyholderConfig): string {
  return (cfg.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT) + OVERVIEW_LIMIT_HINWEIS;
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
  try {
    const overview = await buildOverview(username);
    overviewText = `\n\n--- Aktueller Status des Users ---\n${JSON.stringify(overview, null, 2)}`;
  } catch {
    // non-fatal if overview fails
  }

  // Device list — KG cages + non-KG devices
  let deviceListText = "";
  try {
    const devices = await prisma.device.findMany({
      where: { userId, archivedAt: null },
      include: { category: { select: { name: true, slug: true, isBuiltIn: true } } },
    });
    const kgCages = devices
      .filter((d) => d.category?.slug === "kg")
      .map((d) => d.name);
    const nonKgDevices = devices
      .filter((d) => d.category?.slug !== "kg")
      .map((d) => `${d.name} (${d.category?.name ?? "?"})`);
    const parts: string[] = [];
    if (kgCages.length > 0) parts.push(`KG-Käfige: ${kgCages.join(", ")}`);
    if (nonKgDevices.length > 0) parts.push(`Andere Geräte: ${nonKgDevices.join(", ")}`);
    if (parts.length > 0)
      deviceListText = `\n\n--- Verfügbare Geräte des Users ---\n${parts.join("\n")}`;
  } catch { /* non-fatal */ }

  // Session categories (for create_session_anforderung action)
  let sessionCategoriesText = "";
  try {
    const sessionCats = await prisma.deviceCategory.findMany({
      where: { userId, isSessionCategory: true },
      select: {
        name: true,
        maxSessionMinutes: true,
        orgasmusZiel: true,
        devices: { where: { archivedAt: null }, select: { name: true } },
      },
    });
    if (sessionCats.length > 0) {
      sessionCategoriesText = `\n\n--- Verfügbare Session-Kategorien (für create_session_anforderung) ---\n` +
        sessionCats.map((c) => {
          const deviceNames = c.devices.length > 0 ? ` [Devices: ${c.devices.map((d) => d.name).join(", ")}]` : " [keine Devices]";
          const ziel = c.orgasmusZiel !== "KEINE" ? ` | Ziel: ${c.orgasmusZiel === "ERFORDERLICH" ? "Orgasmus erforderlich" : "Orgasmus verboten"}` : "";
          return `${c.name} (max. ${c.maxSessionMinutes} Min.${ziel})${deviceNames}`;
        }).join("\n");
    }
  } catch { /* non-fatal */ }

  // Kontrolle cooldown info — per Device (CAGE / PLUG separat)
  let kontrolleCooldownText = "";
  try {
    const cooldownLines: string[] = [];
    for (const dev of ["CAGE", "PLUG"] as const) {
      const lastKon = await prisma.kontrollAnforderung.findFirst({
        where: { userId, device: dev },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (lastKon) {
        const minSince = Math.floor((Date.now() - lastKon.createdAt.getTime()) / 60000);
        if (minSince < 60) {
          cooldownLines.push(`${dev}: letzte vor ${minSince} Min. — nächste frühestens in ${60 - minSince} Min.`);
        }
      }
    }
    if (cooldownLines.length > 0) {
      kontrolleCooldownText = `\n\n⚠ Kontrolle-Cooldown aktiv:\n${cooldownLines.join("\n")}\ncreate_kontrolle für betroffenes Device NICHT verwenden.`;
    }
  } catch { /* non-fatal */ }

  // Tagesform — letzte 3 Tage für Verhaltenssteuerung
  let tagesformText = "";
  try {
    const since = new Date(Date.now() - 3 * 86_400_000);
    const tagesformen = await prisma.tagesform.findMany({
      where: { userId, datum: { gte: since } },
      orderBy: { datum: "desc" },
      select: { datum: true, erregung: true, koerper: true, headspace: true, notiz: true },
    });
    if (tagesformen.length > 0) {
      const rows = tagesformen.map((tf) => {
        const d = tf.datum.toISOString().split("T")[0];
        const notizPart = tf.notiz ? ` | Notiz: "${tf.notiz}"` : "";
        return `  ${d}: 🔥 Erregung ${tf.erregung}/5 · 💪 Körper ${tf.koerper}/5 · 🧠 Headspace ${tf.headspace}/5${notizPart}`;
      });
      const latest = tagesformen[0];
      const rules: string[] = [];
      if (latest.koerper <= 2)
        rules.push("⚠ Körperliches Wohlbefinden niedrig (≤2) — KEINE create_sperrzeit und KEIN Einschluss-Druck. Fürsorge hat Vorrang.");
      if (latest.erregung >= 4)
        rules.push("✓ Erregung/Frustration hoch (≥4) — Gute Gelegenheit für Aufgaben, Verlängerungen oder Plug-Anforderungen.");
      if (latest.headspace <= 1)
        rules.push("⚠ Mentale Verfassung sehr niedrig (1) — Sanfter Ton, keine Strafen, keine neuen Anforderungen. Zeige Verständnis.");
      tagesformText =
        "\n\n--- Tagesform des Users (letzte Tage) ---\n" +
        rows.join("\n") +
        (rules.length > 0 ? "\n\nVerhaltensregeln basierend auf aktueller Tagesform:\n" + rules.join("\n") : "");
    }
  } catch { /* non-fatal */ }

  // Strafbuch — kompakte Zusammenfassung (analog zum autonomen Run)
  let strafbuchText = "";
  try {
    const sb = await mcpStrafbuch(username);
    if (sb.detectedOffenseCount > 0) {
      const lines: string[] = [
        `Vergehen gesamt erkannt: ${sb.detectedOffenseCount}, davon offen: ${sb.openOffenseCount}, ausstehende Strafe: ${sb.pendingPenaltyCount}`,
      ];
      for (const o of sb.unauthorizedOpenings)
        lines.push(`- Unerlaubtes Öffnen am ${o.time} (Urteil: ${o.judgment})`);
      for (const o of sb.lateControls)
        lines.push(`- Verspätete Kontrolle (Code ${o.code}, Frist ${o.deadline}, Urteil: ${o.judgment})`);
      for (const o of sb.rejectedControls)
        lines.push(`- Abgelehnte Kontrolle (Code ${o.code}, Urteil: ${o.judgment})`);
      for (const o of sb.cleaningLimitViolations)
        lines.push(`- Reinigungslimit überschritten am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      for (const o of sb.wrongDeviceViolations)
        lines.push(`- Falsches Gerät (${o.deviceName ?? "?"}) am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      for (const o of sb.missedOrgasmInstructions)
        lines.push(`- Verpasste Orgasmus-Anweisung (Fenster bis ${o.windowEndedAt}, Urteil: ${o.judgment})`);
      for (const o of sb.erektionViolations)
        lines.push(`- Erektion beim Öffnen (${o.oeffnenGrund ?? "?"}) am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      strafbuchText = `\n\n--- Strafbuch ---\n${lines.join("\n")}`;
    }
  } catch { /* non-fatal */ }

  const systemMessage: LlmMessage = {
    role: "system",
    content:
      buildSystemPrompt(cfg) +
      overviewText +
      deviceListText +
      sessionCategoriesText +
      kontrolleCooldownText +
      tagesformText +
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
      "Wenn du 'deinen Plug tragen' ankündigst, MUSS ein [ACTION:{\"action\":\"create_wear_anforderung\",...}] Tag folgen — sonst ist es nur Text ohne Wirkung.\n\n" +
      "Beispiele:\n" +
      "User ist offen → 'Schliesse dich jetzt mit dem Peniskäfig Pink ein.[ACTION:{\"action\":\"create_anforderung\",\"fristH\":2,\"dauerH\":null,\"nachricht\":\"Schliesse dich mit dem Peniskäfig Pink ein.\"}]'\n" +
      "User ist verschlossen → 'Ich verlange einen Nachweis.[ACTION:{\"action\":\"create_kontrolle\",\"kommentar\":null,\"requireCode\":true,\"device\":\"CAGE\"}]'\n\n" +
      "Verfügbare Aktionen:\n" +
      "- set_vorgabe: {\"action\":\"set_vorgabe\",\"vorgabeTagH\":null|number,\"vorgabeWocheH\":null|number,\"vorgabeMonatH\":null|number,\"vorgabeNotiz\":null|string}\n" +
      "  → mind. ein Zeitwert erforderlich\n" +
      "- create_kontrolle: {\"action\":\"create_kontrolle\",\"kommentar\":null|string,\"requireCode\":true|false,\"device\":\"CAGE\"|\"PLUG\"}\n" +
      "  → NUR wenn lock.isLocked. device: Gerät der Kontrolle (CAGE=Keuschheitsgürtel, PLUG=Plug). requireCode=true: sendet Code per E-Mail (Standard). requireCode=false: nur Foto-Nachweis\n" +
      "- create_anforderung: {\"action\":\"create_anforderung\",\"fristH\":number,\"dauerH\":null|number,\"nachricht\":null|string}\n" +
      "  → NUR wenn !lock.isLocked. nachricht MUSS den zu verwendenden Käfig/Gerät nennen (z.B. 'Schliesse dich mit dem Peniskäfig Pink ein.').\n" +
      "- create_sperrzeit: {\"action\":\"create_sperrzeit\",\"sperrDauerH\":number}\n" +
      "  → NUR wenn lock.isLocked\n" +
      "- create_orgasmus: {\"action\":\"create_orgasmus\",\"orgasmusArt\":\"ANWEISUNG\"|\"GELEGENHEIT\",\"fensterdauerH\":number,\"orgasmusVorgegebeneArt\":null|\"Orgasmus\"|\"ruinierter Orgasmus\"|\"feuchter Traum\",\"oeffnenErlaubt\":boolean}\n" +
      "  → orgasmusVorgegebeneArt MUSS exakt einem der gelisteten Werte entsprechen oder null (= beliebig). Bei ruiniertem Orgasmus: orgasmusVorgegebeneArt=\"ruinierter Orgasmus\", oeffnenErlaubt=false.\n" +
      "- create_wear_anforderung: {\"action\":\"create_wear_anforderung\",\"wearDeviceName\":string,\"wearDurationH\":number}\n" +
      "  → Erstellt eine offizielle Trage-Anforderung (VerschlussAnforderung) für ein Nicht-KG-Gerät (Plug, etc.). Der User erhält Push + E-Mail und muss die Anforderung in der App erfüllen.\n" +
      "- create_strafe: {\"action\":\"create_strafe\",\"notiz\":string}\n" +
      "  → Verhänge eine Strafe im Strafbuch. notiz = kurze Begründung (z.B. 'Keine Trainingseinheit absolviert').\n" +
      "- create_session_anforderung: {\"action\":\"create_session_anforderung\",\"sessionCategoryName\":string,\"nachricht\":null|string,\"deadlineH\":null|number}\n" +
      "  → Fordere den User auf, eine Trainings-Session in einer Session-Kategorie zu starten. sessionCategoryName muss exakt einem Namen aus der Session-Kategorien-Liste entsprechen. deadlineH = Stunden bis zur Frist (null = keine).\n\n" +
      "Bei normalen Gesprächen ohne Aktion: kein Tag.",
  };

  // Recent chat history (user + assistant + action confirmations)
  // Action confirmations (role="system", prefix "[Aktion]") are injected as
  // user-side context messages so the LLM can see its own actions were real.
  const history = await prisma.aiKeyholderMessage.findMany({
    where: { userId, role: { in: ["user", "assistant", "system"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const historyMessages: LlmMessage[] = history
    .reverse()
    .flatMap((m): LlmMessage[] => {
      if (m.role === "system" && m.content.startsWith("[Aktion]")) {
        // Inject action result as a user-turn system note so the LLM sees confirmation
        return [{ role: "user", content: `[System-Bestätigung] ${m.content}` }];
      }
      if (m.role === "user" || m.role === "assistant") {
        return [{ role: m.role, content: m.content }];
      }
      return [];
    });

  return [systemMessage, ...historyMessages];
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
    const result = await createVerschlussAnforderung({ userId, art: "ANFORDERUNG", fristH, dauerH, nachricht });
    await logEntry(result.ok ? `Einschluss-Anforderung gestellt (Frist: ${fristH}h)` : `Anforderung fehlgeschlagen: ${result.error}`);
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
    const result = await createOrgasmusAnforderung({
      userId, art, beginntAt, endetAt,
      vorgegebeneArt: (action.orgasmusVorgegebeneArt as string | null) ?? null,
      oeffnenErlaubt: typeof action.oeffnenErlaubt === "boolean" ? action.oeffnenErlaubt : true,
    });
    await logEntry(result.ok ? `Orgasmus-${art} erteilt (${fensterdauerH}h)` : `Orgasmus fehlgeschlagen: ${result.error}`);
    return { ok: result.ok, actionType: "create_orgasmus", label: `Orgasmus-${art}`, error: result.ok ? undefined : result.error };
  }

  // ── create_wear_anforderung ──
  if (action.action === "create_wear_anforderung") {
    const deviceName = (action.wearDeviceName as string | null) ?? "";
    const durationH = typeof action.wearDurationH === "number" && action.wearDurationH > 0 ? action.wearDurationH : 2;
    if (!deviceName) return { ok: false, actionType: "create_wear_anforderung", label: "Wear-Anforderung", error: "Kein Gerätename" };
    const device = await prisma.device.findFirst({
      where: { userId, name: deviceName, archivedAt: null },
      select: { id: true, categoryId: true },
    });
    if (!device?.categoryId) return { ok: false, actionType: "create_wear_anforderung", label: "Wear-Anforderung", error: `Gerät "${deviceName}" nicht gefunden` };
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
      data: { userId, offenseType: "AI_KEYHOLDER", refId, bestraftDatum: new Date(), notiz, judgedBy: "ai" },
    });
    await logEntry(`Strafe verhängt: ${notiz}`);
    // Visible event bubble in chat history
    await prisma.aiKeyholderMessage.create({
      data: { userId, role: "system", content: `[Strafe] ${notiz}` },
    });
    await sendPushToUser(userId, "Strafe von deiner Keyholderin", notiz, "/dashboard/keyholder");
    return { ok: true, actionType: "create_strafe", label: `Strafe: ${notiz}` };
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
    const deadlineH = typeof action.deadlineH === "number" && action.deadlineH > 0 ? action.deadlineH : null;
    const nachricht = (action.nachricht as string | null)?.trim() || null;
    const endetAt = deadlineH ? new Date(Date.now() + deadlineH * 60 * 60 * 1000) : null;
    await prisma.sessionAnforderung.create({
      data: { userId, deviceCategoryId: category.id, nachricht, endetAt },
    });
    const pushBody = nachricht ?? `Session mit ${category.name} gefordert${endetAt ? ` (bis ${endetAt.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })})` : ""}`;
    await sendPushToUser(userId, "Session-Anforderung", pushBody, "/dashboard/new/session-begin");
    await logEntry(`Session-Anforderung gestellt: ${category.name}${deadlineH ? ` (Frist: ${deadlineH}h)` : ""}`);
    return { ok: true, actionType: "create_session_anforderung", label: `Session: ${category.name}` };
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
  try {
    const overview = await buildOverview(username);
    overviewText = JSON.stringify(overview, null, 2);
  } catch (e) {
    return { acted: false, summary: `overview error: ${e}` };
  }

  // Strafbuch — compact summary for the agent (avoid token bloat)
  let strafbuchText = "";
  try {
    const sb = await mcpStrafbuch(username);
    if (sb.detectedOffenseCount > 0) {
      const lines: string[] = [
        `Vergehen gesamt erkannt: ${sb.detectedOffenseCount}, davon offen: ${sb.openOffenseCount}, ausstehende Strafe: ${sb.pendingPenaltyCount}`,
      ];
      for (const o of sb.unauthorizedOpenings)
        lines.push(`- Unerlaubtes Öffnen am ${o.time} (Urteil: ${o.judgment})`);
      for (const o of sb.lateControls)
        lines.push(`- Verspätete Kontrolle (Code ${o.code}, Frist ${o.deadline}, Urteil: ${o.judgment})`);
      for (const o of sb.rejectedControls)
        lines.push(`- Abgelehnte Kontrolle (Code ${o.code}, Urteil: ${o.judgment})`);
      for (const o of sb.cleaningLimitViolations)
        lines.push(`- Reinigungslimit überschritten am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      for (const o of sb.wrongDeviceViolations)
        lines.push(`- Falsches Gerät (${o.deviceName ?? "?"}) am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      for (const o of sb.missedOrgasmInstructions)
        lines.push(`- Verpasste Orgasmus-Anweisung (Fenster bis ${o.windowEndedAt}, Urteil: ${o.judgment})`);
      for (const o of sb.erektionViolations)
        lines.push(`- Erektion beim Öffnen (${o.oeffnenGrund ?? "?"}) am ${o.time ?? "?"} (Urteil: ${o.judgment})`);
      strafbuchText = `\n\n--- Strafbuch ---\n${lines.join("\n")}`;
    }
  } catch { /* non-fatal */ }

  // Non-KG devices (for wear-anforderung action)
  let deviceList: string[] = [];
  try {
    const devices = await prisma.device.findMany({
      where: { userId, archivedAt: null },
      include: { category: { select: { name: true, isBuiltIn: true } } },
    });
    deviceList = devices
      .filter((d) => !d.category?.isBuiltIn)
      .map((d) => `${d.name} (${d.category?.name ?? "?"})`);
  } catch { /* non-fatal */ }

  const deviceListText = deviceList.length > 0
    ? `\n\nVerfügbare Geräte zum Anweisen (non-KG, nicht-archiviert):\n${deviceList.join(", ")}`
    : "";

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

  const agentPrompt: LlmMessage[] = [
    {
      role: "system",
      content:
        buildSystemPrompt(cfg) +
        "\n\nDu führst jetzt eine autonome Überprüfung durch. " +
        "Analysiere den Status des Users und entscheide ob eine Aktion nötig ist. " +
        "Antworte mit einem JSON-Objekt (kein Markdown, nur JSON):\n" +
        '{ "act": boolean, ' +
        '"action": "none"|"send_message"|"assign_media"|"create_kontrolle"|"create_strafe"|"create_anforderung"|"create_sperrzeit"|"create_orgasmus"|"set_vorgabe"|"create_wear_anforderung"|"create_session_anforderung", ' +
        '"message": "...", "mediaIndex": 0|null, "kommentar": null|"...", "strafeNotiz": null|"...", ' +
        '"fristH": null|number, "dauerH": null|number, "sperrDauerH": null|number, ' +
        '"orgasmusArt": null|"ANWEISUNG"|"GELEGENHEIT", "fensterdauerH": null|number, ' +
        '"orgasmusVorgegebeneArt": null|"Orgasmus"|"ruinierter Orgasmus"|"feuchter Traum", "oeffnenErlaubt": null|boolean, ' +
        '"vorgabeTagH": null|number, "vorgabeWocheH": null|number, "vorgabeMonatH": null|number, "vorgabeNotiz": null|string, ' +
        '"wearDeviceName": null|string, "wearDurationH": null|number, "requireCode": null|boolean, ' +
        '"device": null|"CAGE"|"PLUG", ' +
        '"sessionCategoryName": null|string, "sessionDeadlineH": null|number }' +
        "\n\nact=false → keine Aktion nötig.\n" +
        'action="send_message" → sende dem User eine Nachricht (message Feld).\n' +
        'action="assign_media" → weise ein Medienelement als Aufgabe zu (mediaIndex + message).\n' +
        'action="create_kontrolle" → fordere eine Foto-Kontrolle an (nur wenn User VERSCHLOSSEN ist). ' +
        'kommentar = Anweisung für den User. device="CAGE" (Keuschheitsgürtel, Standard) oder "PLUG" (Plug). ' +
        'requireCode=true (Standard): sendet Zufalls-Code per E-Mail. ' +
        'requireCode=false: nur Foto-Nachweis ohne Code (sinnvoll wenn lock.hasKontrollCode=false). Sendet E-Mail + Push automatisch.\n' +
        'action="create_strafe" → verhänge eine Strafe im Strafbuch (strafeNotiz = kurze Begründung, message = Chat-Text). ' +
        'Nur bei klaren Regelverstößen verwenden. Beachte das Strafbuch: bereits beurteilte Vergehen nicht nochmals bestrafen.\n' +
        'action="create_anforderung" → fordere den User auf, sich einzuschliessen (nur wenn User OFFEN ist). ' +
        'fristH = Stunden bis zur Frist (z.B. 2), dauerH = Mindest-Tragedauer in Stunden (optional), message = Nachricht im Chat.\n' +
        'action="create_sperrzeit" → setze eine Sperrzeit (User darf sich nicht öffnen), nur wenn User VERSCHLOSSEN ist. ' +
        'sperrDauerH = Dauer in Stunden (z.B. 12), message = Nachricht im Chat.\n' +
        'action="create_orgasmus" → erteile dem User eine Orgasmus-Anweisung oder -Gelegenheit. ' +
        'orgasmusArt="ANWEISUNG" (User MUSS Orgasmus erfassen) oder "GELEGENHEIT" (User DARF). ' +
        'fensterdauerH = Zeitfenster in Stunden (z.B. 4). ' +
        'orgasmusVorgegebeneArt = erforderliche Art — EXAKT ein Wert aus der Orgasmus-Arten-Liste des Users (z.B. "ruinierter Orgasmus", "Orgasmus", "feuchter Traum") oder null für beliebig. ' +
        'oeffnenErlaubt = true wenn User sich dafür öffnen darf ohne Strafe, false wenn er verschlossen bleiben muss (z.B. ruinierter Orgasmus als Strafe). ' +
        'Wenn User VERSCHLOSSEN ist: setze oeffnenErlaubt=false und orgasmusVorgegebeneArt="ruinierter Orgasmus" für einen ruinierten Orgasmus als Strafe. ' +
        'message = Nachricht im Chat.\n' +
        'action="set_vorgabe" → setze oder ändere die Trage-Trainingsvorgabe des Users (Mindeststunden). ' +
        'vorgabeTagH/vorgabeWocheH/vorgabeMonatH = Mindeststunden pro Periode (mind. einer muss gesetzt sein). ' +
        'vorgabeNotiz = kurze Begründung (z.B. "Intensivierungsphase"). message = Chat-Text.\n' +
        'action="create_wear_anforderung" → erstellt eine offizielle Trage-Anforderung für ein Non-KG-Gerät (Plug, etc.); der User bekommt Push/E-Mail und muss es in der App bestätigen. ' +
        'wearDeviceName = exakter Gerätename aus der Geräteliste (muss exakt übereinstimmen). wearDurationH = Frist in Stunden. message = kurze Erklärung im Chat.\n' +
        'action="create_session_anforderung" → fordere den User auf, eine Trainings-Session in einer Session-Kategorie zu starten. ' +
        'sessionCategoryName = exakter Name aus der Session-Kategorien-Liste. sessionDeadlineH = Frist in Stunden (null = keine). message = Anweisung im Chat.\n\n' +
        'PFLICHT-CONSTRAINTS (NIEMALS ignorieren):\n' +
        '- create_anforderung NUR wenn lock.isLocked === false\n' +
        '- create_sperrzeit NUR wenn lock.isLocked === true\n' +
        '- create_kontrolle NUR wenn lock.isLocked === true\n' +
        '  Wenn lock.hasKontrollCode === false: requireCode=false setzen (nur Foto-Nachweis, kein Code)\n' +
        '  Wenn lock.hasKontrollCode === true: requireCode=true (Standard, Siegel-Nummer + Code wird geprüft)\n' +
        '- NUR EINE action pro Run. Wenn du mehrere Dinge tun willst, wähle jetzt die wichtigste.\n' +
        '- Plug/Device tragen ankündigen ohne create_wear_anforderung = wirkungslos. Immer action setzen.\n' +
        'Verstoss gegen diese Regeln erzeugt einen Fehler und keine Aktion wird ausgeführt.',
    },
    {
      role: "user",
      content: `Aktueller Status:\n${overviewText}${strafbuchText}${deviceListText}${mediaList}`,
    },
  ];

  let raw = "";
  try {
    raw = await llmChat(toLlmConfig(cfg), agentPrompt);
    // Strip markdown code fences if present
    raw = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const decision = JSON.parse(raw) as {
      act: boolean;
      action: string;
      message: string;
      mediaIndex: number | null;
      kommentar?: string | null;
      strafeNotiz?: string | null;
      fristH?: number | null;
      dauerH?: number | null;
      sperrDauerH?: number | null;
      orgasmusArt?: "ANWEISUNG" | "GELEGENHEIT" | null;
      fensterdauerH?: number | null;
      orgasmusVorgegebeneArt?: string | null;
      oeffnenErlaubt?: boolean | null;
      vorgabeTagH?: number | null;
      vorgabeWocheH?: number | null;
      vorgabeMonatH?: number | null;
      vorgabeNotiz?: string | null;
      wearDeviceName?: string | null;
      wearDurationH?: number | null;
      requireCode?: boolean;
      device?: "CAGE" | "PLUG" | null;
      sessionCategoryName?: string | null;
      sessionDeadlineH?: number | null;
    };

    if (!decision.act) {
      await prisma.aiKeyholderConfig.update({
        where: { userId },
        data: { lastRunAt: new Date() },
      });
      return { acted: false, summary: "agent decided: no action" };
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
          ? `[Kontrolle] ${decision.message ?? "Foto-Kontrolle angefordert."} (Frist: ${new Date(result.data.deadline).toLocaleString("de-CH")})`
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

        const result = await createVerschlussAnforderung({
          userId,
          art: "ANFORDERUNG",
          nachricht: decision.message ?? null,
          fristH,
          dauerH: dauerH ?? null,
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

      const result = await createOrgasmusAnforderung({
        userId,
        art,
        nachricht: decision.message ?? null,
        beginntAt,
        endetAt,
        vorgegebeneArt: decision.orgasmusVorgegebeneArt ?? null,
        oeffnenErlaubt: decision.oeffnenErlaubt === true,
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
      const device = await prisma.device.findFirst({
        where: { userId, name: deviceName, archivedAt: null },
        select: { id: true, categoryId: true },
      });
      if (device?.categoryId) {
        const nachricht = decision.message ?? `Trage ${deviceName} für ${durationH} Stunden.`;
        await createVerschlussAnforderung({ userId, art: "ANFORDERUNG", deviceCategoryId: device.categoryId, deviceId: device.id, nachricht, fristH: durationH });
      }
      const eventText = `[Wear-Anforderung] ${deviceName} für ${durationH}h`;
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

      if (!category) {
        await prisma.aiKeyholderMessage.create({
          data: { userId, role: "system", content: `[Autonome Prüfung] [Session-Anforderung] Übersprungen: Session-Kategorie "${categoryName}" nicht gefunden.` },
        });
      } else {
        const deadlineH = typeof decision.sessionDeadlineH === "number" && decision.sessionDeadlineH > 0
          ? decision.sessionDeadlineH
          : null;
        const endetAt = deadlineH ? new Date(Date.now() + deadlineH * 60 * 60 * 1000) : null;

        await prisma.sessionAnforderung.create({
          data: { userId, deviceCategoryId: category.id, nachricht: decision.message ?? null, endetAt },
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

        const pushBody = decision.message ?? `Session mit ${category.name} gefordert${endetAt ? ` (bis ${endetAt.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })})` : ""}`;
        await sendPushToUser(userId, "Session-Anforderung", pushBody.slice(0, 100), "/dashboard/new/session-begin");
      }

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
    overviewSnippet = activeWear.length > 0
      ? `\nAktuell aktive Tragesessionen: ${activeWear.map((s: { category: string; deviceName: string }) => `${s.deviceName} (${s.category})`).join(", ")}.`
      : "\nAktuell keine aktiven Tragesessionen (kein Gerät wird gerade getragen).";
  } catch {
    // non-fatal
  }

  const reactionMessages: LlmMessage[] = [
    {
      role: "system",
      content:
        buildSystemPrompt(cfg) +
        "\n\nDer User hat soeben eine Aufgabe abgeschlossen. Reagiere kurz und in der Rolle der Keyholderin." +
        overviewSnippet,
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
): Promise<void> {
  try {
    const cfg = await getKeyholderConfig(userId);
    if (!cfg?.enabled) return;

    // Build a compact overview for context (non-fatal if it fails)
    let overviewText = "";
    try {
      const overview = await buildOverview(username);
      overviewText = JSON.stringify(overview, null, 2);
    } catch { /* non-fatal */ }

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
          "Wenn das Ereignis ungewöhnlich oder gegen Regeln ist, reagiere entsprechend streng.",
      },
      {
        role: "user",
        content: `Aktuelles Ereignis: ${username} ${eventLabel}.${noteHint}\n\nStatus:\n${overviewText}`,
      },
    ];

    const reactionText = await llmChat(toLlmConfig(cfg), reactionMessages);
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
