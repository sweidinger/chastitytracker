import { prisma } from "@/lib/prisma";
import { buildTagesformContext, tagesformPromptText, type TagesformView } from "@/lib/tagesformService";

/** Cooldown zwischen zwei Kontrollen desselben Geräts (Minuten). Muss zur serverseitigen
 *  Durchsetzung in keyholderService passen — der Prompt-Text ist nur die Vorwarnung. */
const KONTROLLE_COOLDOWN_MIN = 60;

/** Geräte-Liste: KG-Käfige UND Nicht-KG-Geräte.
 *  Der autonome Lauf filterte früher `!isBuiltIn` — und schloss damit ausgerechnet die KG-Käfige
 *  aus, deren exakten Namen sein eigener Prompt für `anforderungDeviceName` verlangt. */
async function buildDeviceListText(userId: string): Promise<string> {
  try {
    const devices = await prisma.device.findMany({
      where: { userId, archivedAt: null },
      include: { category: { select: { name: true, slug: true } } },
    });
    const kgCages = devices.filter((d) => d.category?.slug === "kg").map((d) => d.name);
    const nonKgDevices = devices
      .filter((d) => d.category?.slug !== "kg")
      .map((d) => `${d.name} (${d.category?.name ?? "?"})`);

    const parts: string[] = [];
    if (kgCages.length > 0) parts.push(`KG-Käfige (für anforderungDeviceName): ${kgCages.join(", ")}`);
    if (nonKgDevices.length > 0) parts.push(`Andere Geräte (für wearDeviceName): ${nonKgDevices.join(", ")}`);
    return parts.length > 0
      ? `\n\n--- Verfügbare Geräte des Users (Namen EXAKT übernehmen) ---\n${parts.join("\n")}`
      : "";
  } catch {
    return "";
  }
}

/** Session-Kategorien für create_session_anforderung. */
async function buildSessionCategoriesText(userId: string): Promise<string> {
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
    if (sessionCats.length === 0) return "";
    return (
      "\n\n--- Verfügbare Session-Kategorien (für create_session_anforderung, sessionCategoryName EXAKT) ---\n" +
      sessionCats
        .map((c) => {
          const deviceNames = c.devices.length > 0 ? ` [Devices: ${c.devices.map((d) => d.name).join(", ")}]` : " [keine Devices]";
          const ziel = c.orgasmusZiel !== "KEINE" ? ` | Ziel: ${c.orgasmusZiel === "ERFORDERLICH" ? "Orgasmus erforderlich" : "Orgasmus verboten"}` : "";
          return `${c.name} (max. ${c.maxSessionMinutes} Min.${ziel})${deviceNames}`;
        })
        .join("\n")
    );
  } catch {
    return "";
  }
}

/** Kontrolle-Cooldown pro Gerät (CAGE / PLUG getrennt). */
async function buildKontrolleCooldownText(userId: string, now: Date = new Date()): Promise<string> {
  try {
    const cooldownLines: string[] = [];
    for (const dev of ["CAGE", "PLUG"] as const) {
      const lastKon = await prisma.kontrollAnforderung.findFirst({
        where: { userId, device: dev },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (!lastKon) continue;
      const minSince = Math.floor((now.getTime() - lastKon.createdAt.getTime()) / 60_000);
      if (minSince < KONTROLLE_COOLDOWN_MIN) {
        cooldownLines.push(
          `${dev}: letzte vor ${minSince} Min. — nächste frühestens in ${KONTROLLE_COOLDOWN_MIN - minSince} Min.`,
        );
      }
    }
    return cooldownLines.length > 0
      ? `\n\n⚠ Kontrolle-Cooldown aktiv:\n${cooldownLines.join("\n")}\ncreate_kontrolle für betroffenes Device NICHT verwenden (wird serverseitig hart abgelehnt).`
      : "";
  } catch {
    return "";
  }
}

/** Baut den gemeinsamen Kontext für alle Prompt-Pfade (Chat, autonomer Lauf, Reaktionen) als
 *  ein anhängbarer String — Geräte, Session-Kategorien, Kontrolle-Cooldown, Tagesform, in stabiler
 *  Reihenfolge. Jeder Baustein ist für sich non-fatal: schlägt eine Query fehl, fehlt nur dieser Block.
 *
 *  `tagesformView` durchreichen, wenn der Aufrufer das Overview ohnehin schon geladen hat
 *  (`overview.tagesform`) — dann entfällt die zweite Tagesform-Query. */
export async function buildSharedPromptContext(
  userId: string,
  tagesformView?: TagesformView,
): Promise<string> {
  const [deviceListText, sessionCategoriesText, kontrolleCooldownText, tagesformText] = await Promise.all([
    buildDeviceListText(userId),
    buildSessionCategoriesText(userId),
    buildKontrolleCooldownText(userId),
    tagesformView ? Promise.resolve(tagesformPromptText(tagesformView)) : buildTagesformContext(userId),
  ]);

  return deviceListText + sessionCategoriesText + kontrolleCooldownText + tagesformText;
}
