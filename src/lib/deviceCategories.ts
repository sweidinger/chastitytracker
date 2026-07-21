import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "@/lib/queries";

/** Stable slug for the built-in KG category — referenced by buildPairs gating, API
 *  validation, and admin UI to identify "the KG category" reliably regardless of name. */
export const KG_BUILTIN_SLUG = "kg";

/** Stable slug for the built-in Anal-Plug category. */
export const PLUG_BUILTIN_SLUG = "plug";

/** Default visual identity for the built-in KG category (per UI Designer spec). */
const KG_BUILTIN_COLOR = "cat-steel";
const KG_BUILTIN_ICON = "Lock";

/** Die KG-Kategorie als Pillen-/Varianten-Eintrag — EINE Quelle für alle Umschalter (Tragekalender,
 *  Device-Nutzung), damit ein Re-Skin von KG nicht an drei Stellen nachgezogen werden muss.
 *  `name` bleibt der Produktbegriff „KG" (steht so auch in `messages/*.json` und in der DB-Zeile). */
export const KG_CATEGORY_META = {
  id: KG_BUILTIN_SLUG,
  name: "KG",
  color: KG_BUILTIN_COLOR,
  icon: KG_BUILTIN_ICON,
} as const;

/** Builds the deterministic ID used for KG built-in categories (matches the migration backfill).
 *  Stable across deploys so application code can reference KG without an extra query. */
export function kgCategoryId(userId: string): string {
  return `kgcat_${userId}`;
}

/** Idempotently creates the user's KG built-in category if missing.
 *  Uses an upsert by deterministic ID so concurrent calls and re-runs are safe.
 *  Call from every user-creation path (admin create, demo, seed). */
export async function ensureKgCategory(userId: string, tx?: PrismaTx): Promise<void> {
  const client = tx ?? prisma;
  await client.deviceCategory.upsert({
    where: { id: kgCategoryId(userId) },
    update: {},
    create: {
      id: kgCategoryId(userId),
      userId,
      name: "KG",
      slug: KG_BUILTIN_SLUG,
      color: KG_BUILTIN_COLOR,
      icon: KG_BUILTIN_ICON,
      isBuiltIn: true,
      trackingEnabled: true,
      sortOrder: 0,
    },
  });
}

/** Builds the deterministic ID used for Anal-Plug built-in categories. */
export function plugCategoryId(userId: string): string {
  return `plugcat_${userId}`;
}

const PLUG_BUILTIN_COLOR = "cat-plum";
const PLUG_BUILTIN_ICON = "Anchor";

/** Idempotently creates the user's Anal-Plug built-in category if missing.
 *  Mirrors ensureKgCategory — call alongside it from every user-creation path. */
export async function ensurePlugCategory(userId: string, tx?: PrismaTx): Promise<void> {
  const client = tx ?? prisma;
  await client.deviceCategory.upsert({
    where: { id: plugCategoryId(userId) },
    update: {},
    create: {
      id: plugCategoryId(userId),
      userId,
      name: "Anal-Plug",
      slug: PLUG_BUILTIN_SLUG,
      color: PLUG_BUILTIN_COLOR,
      icon: PLUG_BUILTIN_ICON,
      isBuiltIn: true,
      trackingEnabled: true,
      sortOrder: 1,
    },
  });
}
