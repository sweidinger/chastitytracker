import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApi, deviceCategoriesGate } from "@/lib/authGuards";
import { entryManageAccess } from "@/lib/keyholder";
import { validateCategoryInput } from "@/lib/categoryConstants";
import { errorResponse } from "@/lib/serviceResult";
import { clamp } from "@/lib/utils";
import type { NumberRange } from "@/lib/constants";
import { resolveCategoryRuleChanges, currentCategoryRules, categoryUsage, categoryDeleteBlock } from "@/lib/deviceCategoryService";

type Params = { params: Promise<{ id: string }> };

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

/** Access check: returns the category if the session user may manage it — owner, global admin, or
 *  keyholder of the owner (same rule as entries/devices, see entryManageAccess).
 *
 *  `elevated` kommt mit zurück (= handelt als Keyholder/Admin, nicht als Eigentümer) — dieselbe
 *  Erweiterung und dieselbe Begründung wie bei `getOwnedDevice`: der Guard berechnet es ohnehin, und
 *  die drei Kategorie-REGELN unten brauchen genau diese Unterscheidung. */
async function getOwnedCategory(id: string, sessionUserId: string, sessionRole: string) {
  const category = await prisma.deviceCategory.findUnique({ where: { id } });
  if (!category) return null;
  const access = await entryManageAccess(sessionUserId, sessionRole, category.userId);
  if (!access.allowed) return null;
  return { ...category, elevated: access.elevated };
}


/** PATCH /api/categories/[id] — Beschriftung (Name, Farbe, Symbol, Sortierung) für den Eigentümer,
 *  die drei REGELN nur für Keyholder/Admin (siehe {@link CATEGORY_RULE_FIELDS}).
 *  Bei der eingebauten Kategorie sind Slug, `isBuiltIn` und die drei Regeln unveränderlich. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const gate = deviceCategoriesGate();
  if (gate) return gate;
  const session = await requireApi();
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const category = await getOwnedCategory(id, session.user.id, session.user.role);
  if (!category) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { name, color, icon, sortOrder } = body;

  const validationError = validateCategoryInput({ name, color, icon });
  if (validationError) return NextResponse.json({ error: validationError.error }, { status: 400 });

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = (name as string).trim();
  if (color !== undefined) data.color = color;
  if (icon !== undefined) data.icon = icon;
  if (sortOrder !== undefined && typeof sortOrder === "number") data.sortOrder = sortOrder;

  // Fork: Session-Kategorie (nicht bei der eingebauten). Setzt der Patch sie AN, stehen die
  // Tragezeit-Regeln fest auf false — geprüft wie jede andere Regel-Änderung (withSessionRules).
  const sessionFlag = !category.isBuiltIn && typeof body.isSessionCategory === "boolean" ? body.isSessionCategory : undefined;
  if (sessionFlag !== undefined) data.isSessionCategory = sessionFlag;
  Object.assign(data, forkCategoryFields(body));

  // Die drei Regeln gehören dem Keyholder — die Entscheidung darüber steht im Service, damit
  // Anlegen und Ändern dieselbe treffen (und sie ohne Prisma prüfbar bleibt).
  const rules = resolveCategoryRuleChanges(
    withSessionRules(body, sessionFlag === true),
    currentCategoryRules(category),
    { isBuiltIn: category.isBuiltIn, elevated: category.elevated },
  );
  if (!rules.ok) return errorResponse(rules.status, rules.code);
  Object.assign(data, rules.data);

  const updated = await prisma.deviceCategory.update({ where: { id }, data });
  return NextResponse.json(updated);
}

/** DELETE /api/categories/[id] — delete user-defined category if no devices/vorgaben link to it.
 *  Built-in cannot be deleted. Returns 409 if linked records exist. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const gate = deviceCategoriesGate();
  if (gate) return gate;
  const session = await requireApi();
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const category = await getOwnedCategory(id, session.user.id, session.user.role);
  if (!category) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (category.isBuiltIn) {
    return NextResponse.json({ error: "Eingebaute Kategorien können nicht gelöscht werden" }, { status: 400 });
  }

  // Welche Verweise blockieren (und warum auch archivierte Geräte und historische Ziele zählen),
  // steht im Service — dieselbe Entscheidung trifft der MCP-Write.
  const usage = await categoryUsage(prisma, id);
  if (categoryDeleteBlock(category, usage) === "in-use") {
    return NextResponse.json({
      error: "Kategorie wird verwendet (Geräte oder Vorgaben verknüpft)",
      deviceCount: usage.deviceCount,
      vorgabeCount: usage.goalCount,
    }, { status: 409 });
  }

  await prisma.deviceCategory.delete({ where: { id } });
  return NextResponse.json({ deleted: true });
}
