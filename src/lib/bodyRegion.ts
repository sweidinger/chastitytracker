import { prisma } from "@/lib/prisma";
import { getActiveWearSessions, getIsLocked } from "@/lib/queries";
import { getActiveSessionsAllCategories } from "@/lib/sessionService";

/**
 * Körperregion-Exklusivität: Zwei Geräte derselben Region (!= "other") dürfen nicht gleichzeitig
 * aktiv sein (z.B. Anal-Plug + Anal-Dildo-Session). Region ist pro DeviceCategory gesetzt
 * (genital = Käfig, anal = Plug/Dildo, other = keine Einschränkung).
 */
export interface RegionConflict {
  region: string;
  blockingCategoryName: string;
  newCategoryName: string;
}

/** Prüft, ob das Aktivieren der Kategorie `newCategoryId` gegen die Region-Exklusivität verstößt:
 *  ein ANDERES Gerät derselben Region ist bereits aktiv. Gibt den Konflikt zurück, sonst null. */
export async function findRegionConflict(
  userId: string,
  newCategoryId: string | null | undefined,
  opts?: { includeOpenRequests?: boolean },
): Promise<RegionConflict | null> {
  if (!newCategoryId) return null;
  const newCat = await prisma.deviceCategory.findUnique({
    where: { id: newCategoryId },
    select: { region: true, name: true },
  });
  const region = newCat?.region ?? "other";
  if (!newCat || region === "other") return null;

  const now = new Date();
  const [wear, sessions, locked] = await Promise.all([
    getActiveWearSessions(userId),
    getActiveSessionsAllCategories(userId),
    getIsLocked(userId),
  ]);

  const activeCatIds = new Set<string>();
  for (const w of wear) activeCatIds.add(w.categoryId);
  for (const s of sessions) activeCatIds.add(s.categoryId);
  if (locked) {
    const kg = await prisma.deviceCategory.findFirst({ where: { userId, slug: "kg" }, select: { id: true } });
    if (kg) activeCatIds.add(kg.id);
  }

  // Optional: auch noch OFFENE (unerfüllte) Anforderungen berücksichtigen — so lässt sich schon beim
  // ANFORDERN verhindern, dass zwei Geräte derselben Region gleichzeitig gefordert werden.
  if (opts?.includeOpenRequests) {
    const notExpired = { OR: [{ endetAt: null }, { endetAt: { gte: now } }] };
    const [openWear, openSess] = await Promise.all([
      prisma.verschlussAnforderung.findMany({
        where: { userId, art: "ANFORDERUNG", fulfilledAt: null, withdrawnAt: null, ...notExpired },
        select: { deviceCategoryId: true },
      }),
      prisma.sessionAnforderung.findMany({
        where: { userId, fulfilledAt: null, withdrawnAt: null, ...notExpired },
        select: { deviceCategoryId: true },
      }),
    ]);
    let kgId: string | null = null;
    for (const w of openWear) {
      if (w.deviceCategoryId) activeCatIds.add(w.deviceCategoryId);
      else {
        // KG-Verschluss-Anforderung ohne Kategorie → KG (genital).
        kgId ??= (await prisma.deviceCategory.findFirst({ where: { userId, slug: "kg" }, select: { id: true } }))?.id ?? null;
        if (kgId) activeCatIds.add(kgId);
      }
    }
    for (const s of openSess) if (s.deviceCategoryId) activeCatIds.add(s.deviceCategoryId);
  }

  activeCatIds.delete(newCategoryId); // dieselbe Kategorie ist kein Konflikt

  if (activeCatIds.size === 0) return null;

  const blocking = await prisma.deviceCategory.findFirst({
    where: { id: { in: [...activeCatIds] }, region },
    select: { name: true },
  });
  return blocking ? { region, blockingCategoryName: blocking.name, newCategoryName: newCat.name } : null;
}
