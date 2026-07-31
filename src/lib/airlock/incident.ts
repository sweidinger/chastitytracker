import { prisma } from "@/lib/prisma";

/**
 * Fall E (docs/UNIVERSAL_LINK_UMSETZUNG.md, Nachtrag §2): Der Sub tippt seinen AKTIV verschlossenen
 * Airlock-Lock an, obwohl gerade KEINE Kontrolle angefordert ist — die einzige „Vorfall"-Situation
 * beim Deep-Link. Die (AI-)Keyholderin soll das mitbekommen: wir speisen eine System-Nachricht in den
 * Keyholder-Chat ein (die KI hat den Scan damit als Kontext), der Sub wird anschliessend in den Chat
 * geleitet (siehe airlock/open/page.tsx). Kein Echtheitsbeweis — nur ein Hinweis.
 *
 * IDEMPOTENT: mehrfaches Antippen darf die Keyholderin nicht zuspammen — kein zweiter Vorfall für
 * denselben User+Lock innerhalb eines kurzen Fensters.
 */
const INCIDENT_MARKER_PREFIX = "[Vorfall] Airlock-Scan bei aktivem Verschluss";
const IDEMPOTENCY_MS = 2 * 60_000; // 2 Minuten

export async function emitAirlockScanIncident(
  userId: string,
  lockCode: string,
  now: Date = new Date(),
): Promise<void> {
  const marker = `${INCIDENT_MARKER_PREFIX} (Lock ${lockCode})`;
  const recent = await prisma.aiKeyholderMessage.findFirst({
    where: {
      userId,
      role: "system",
      content: { startsWith: marker },
      createdAt: { gte: new Date(now.getTime() - IDEMPOTENCY_MS) },
    },
    select: { id: true },
  });
  if (recent) return; // im Fenster bereits gemeldet -> nicht doppelt
  await prisma.aiKeyholderMessage.create({
    data: {
      userId,
      role: "system",
      content:
        `${marker}: Der Sub hat sein aktiv verschlossenes Airlock-Schloss angetippt, obwohl gerade ` +
        `keine Kontrolle angefordert ist. Kein Echtheitsbeweis — nur ein Hinweis, dass er am Schloss war.`,
    },
  });
}
