import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApi, deviceCategoriesGate } from "@/lib/authGuards";
import { entryManageAccess } from "@/lib/keyholder";
import { errorResponse } from "@/lib/serviceResult";
import { createCategory } from "@/lib/deviceCategoryService";
import { validateCategoryInput } from "@/lib/categoryConstants";
import { DEVICE_NAME_MAX_LENGTH } from "@/lib/constants";
import { CATEGORY_LIST_ORDER, CATEGORY_LIST_SELECT } from "@/lib/queries";
import { clamp } from "@/lib/utils";
import type { NumberRange } from "@/lib/constants";

/** Fork: Session-Kategorien (zeitlich begrenzte Sessions statt Tragezeit) und Körperregion. Liest die
 *  gültigen, MITGESCHICKTEN Fork-Felder aus dem Body — Ungültiges fällt still weg wie bisher. */
const ORGASMUS_ZIELE: readonly string[] = ["KEINE", "ERFORDERLICH", "VERBOTEN"];
const CATEGORY_REGIONS: readonly string[] = ["genital", "anal", "other"];
const MAX_SESSION_MINUTES_RANGE = { min: 1, max: 120, fallback: 30 } as const satisfies NumberRange;

function forkCategoryFields(body: Record<string, unknown>) {
  const data: { maxSessionMinutes?: number; requiresVideo?: boolean; orgasmusZiel?: string; region?: string } = {};
  if (typeof body.maxSessionMinutes === "number") data.maxSessionMinutes = clamp(body.maxSessionMinutes, MAX_SESSION_MINUTES_RANGE);
  if (typeof body.requiresVideo === "boolean") data.requiresVideo = body.requiresVideo;
  if (typeof body.orgasmusZiel === "string" && ORGASMUS_ZIELE.includes(body.orgasmusZiel)) data.orgasmusZiel = body.orgasmusZiel;
  if (typeof body.region === "string" && CATEGORY_REGIONS.includes(body.region)) data.region = body.region;
  return data;
}

/** Eine Session-Kategorie misst keine Tragezeit: `trackingEnabled`/`requirePhoto` stehen fest auf
 *  false. Das ist eine Regel-Änderung und läuft deshalb durch dieselbe Schranke wie die Schalter
 *  selbst (nur Keyholder/Admin) — sonst liesse sich die Zeiterfassung über den Umweg
 *  „Session-Kategorie" abschalten. */
function withSessionRules(body: Record<string, unknown>, isSession: boolean): Record<string, unknown> {
  return isSession ? { ...body, trackingEnabled: false, requirePhoto: false } : body;
}

/** GET /api/categories — list current user's DeviceCategories.
 *  Admin may pass ?userId=<id> to fetch another user's categories.
 *  Includes counts (devices, vorgaben) so the list page can show usage. */
export async function GET(req: NextRequest) {
  const gate = deviceCategoriesGate();
  if (gate) return gate;
  const session = await requireApi();
  if (session instanceof NextResponse) return session;

  let userId = session.user.id;
  const queryUserId = req.nextUrl.searchParams.get("userId");
  if (queryUserId && queryUserId !== session.user.id) {
    if (!(await entryManageAccess(session.user.id, session.user.role, queryUserId)).allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    userId = queryUserId;
  }

  const categories = await prisma.deviceCategory.findMany({
    where: { userId },
    orderBy: [...CATEGORY_LIST_ORDER],
    select: CATEGORY_LIST_SELECT,
  });

  return NextResponse.json(
    categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      color: c.color,
      icon: c.icon,
      isBuiltIn: c.isBuiltIn,
      trackingEnabled: c.trackingEnabled,
      requirePhoto: c.requirePhoto,
      allowVorgaben: c.allowVorgaben,
      isSessionCategory: c.isSessionCategory,
      maxSessionMinutes: c.maxSessionMinutes,
      requiresVideo: c.requiresVideo,
      orgasmusZiel: c.orgasmusZiel,
      region: c.region,
      sortOrder: c.sortOrder,
      createdAt: c.createdAt.toISOString(),
      deviceCount: c._count.devices,
      vorgabeCount: c._count.vorgaben,
    })),
  );
}

/** POST /api/categories — create a new user-defined DeviceCategory.
 *  Built-in (slug "kg") cannot be created via API — it's seeded by ensureKgCategory. */
export async function POST(req: NextRequest) {
  const gate = deviceCategoriesGate();
  if (gate) return gate;
  const session = await requireApi();
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const { name, color, icon, sortOrder } = body;
  // Der Name des ERSTEN Geräts, optional. Eine Kategorie ohne Gerät ist eine Sackgasse: erfassen
  // lässt sich darin nichts, und gesagt wird es dem Nutzer nirgends deutlich (Issue #49 — zwei
  // Instanzen standen wochenlang so da und haben danach nie wieder etwas erfasst). Beide Schritte
  // in EINEM Vorgang, damit die Sackgasse gar nicht erst entstehen kann.
  const firstDeviceName = typeof body.firstDeviceName === "string" ? body.firstDeviceName.trim() : "";

  let userId = session.user.id;
  // Handelt der Aufrufer als Keyholder/Admin? Beim eigenen Konto ist ein Träger Eigentümer und damit
  // NICHT erhaben (ein globaler Admin schon) — dieselbe Regel wie in `entryManageAccess`.
  let elevated = session.user.role === "admin";
  if (body.userId && body.userId !== session.user.id) {
    const access = await entryManageAccess(session.user.id, session.user.role, body.userId);
    if (!access.allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    userId = body.userId;
    elevated = access.elevated;
  }

  const validationError = validateCategoryInput({ name, color, icon });
  if (validationError) return NextResponse.json({ error: validationError.error }, { status: 400 });

  // Prosa wie die Prüfungen darüber: diese Route gibt anzeigbare Meldungen zurück, der Aufrufer
  // rendert sie unverändert (`parseApiError`). Ein Code stünde dem Nutzer roh im Fehlerfeld.
  if (firstDeviceName.length > DEVICE_NAME_MAX_LENGTH) {
    return NextResponse.json({ error: `Gerätename zu lang (max. ${DEVICE_NAME_MAX_LENGTH} Zeichen)` }, { status: 400 });
  }

  // Regel-Prüfung, Slug-Vergabe und Anlegen liegen im Service — dieselbe Kette bedient den
  // MCP-Write. Die drei Regeln darf auch beim ANLEGEN nur der Keyholder setzen: sonst wäre die
  // Schranke beim Ändern umgehbar, indem man die Kategorie gleich mit abgeschalteter
  // Zeiterfassung anlegt.
  // Fork: die Session-/Regions-Felder kennt der Service nicht — sie folgen in derselben Transaktion.
  const isSession = body.isSessionCategory === true;
  const { orgasmusZiel, ...forkFields } = forkCategoryFields(body);
  const created = await prisma.$transaction(async (tx) => {
    const outcome = await createCategory(
      tx,
      userId,
      {
        name: name as string,
        color: color as string | undefined,
        icon: icon as string | undefined,
        sortOrder: typeof sortOrder === "number" ? sortOrder : undefined,
        firstDeviceName,
      },
      { elevated },
      withSessionRules(body, isSession),
    );
    if (!outcome.ok) return outcome;
    const category = await tx.deviceCategory.update({
      where: { id: outcome.category.id },
      data: { isSessionCategory: isSession, ...forkFields, ...(isSession && orgasmusZiel ? { orgasmusZiel } : {}) },
    });
    return { ok: true as const, category };
  });
  if (!created.ok) {
    if (created.reason === "rules") return errorResponse(created.status, created.code);
    if (created.reason === "slug-exhausted") {
      return NextResponse.json({ error: "Zu viele Kategorien mit ähnlichem Namen" }, { status: 409 });
    }
    return NextResponse.json({ error: created.error }, { status: 400 });
  }
  return NextResponse.json(created.category, { status: 201 });
}
