import { EntryActionFormShell } from "@/app/components/AdminActionFormShell";
import { actionSign } from "@/app/entries/actionSign";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { deviceCategoriesEnabled } from "@/lib/constants";
import { deviceFormHref } from "@/lib/categoryConstants";
import { getActiveWearSessionForCategory, getMobileDesktopMode } from "@/lib/queries";
import { nowDatetimeLocal, safeInternalPath, APP_TZ } from "@/lib/utils";
import WearForm from "../../WearForm";

export default async function NewWearBeginPage({ searchParams }: { searchParams: Promise<{ category?: string; device?: string; redirectTo?: string; anforderung?: string }> }) {
  if (!deviceCategoriesEnabled()) notFound();
  const session = await auth();
  if (!session) redirect("/login");
  const tz = session.user.timezone ?? APP_TZ;

  // `redirectTo` kommt hier aus der URL (Ketten-Weiterleitung der Aufgaben-Bedingungen) — deshalb
  // durch `safeInternalPath`, anders als bei den serverseitig gebauten Zielen der Admin-Formulare.
  const { category: categoryId, device: wantedDevice, redirectTo, anforderung: anforderungId } = await searchParams;
  if (!categoryId) redirect("/dashboard/categories");
  const target = safeInternalPath(redirectTo) ?? undefined;

  const category = await prisma.deviceCategory.findUnique({
    where: { id: categoryId },
    select: { id: true, userId: true, name: true, color: true, icon: true, isBuiltIn: true, slug: true, requirePhoto: true },
  });
  // Block KG (uses VERSCHLUSS/OEFFNEN, not WEAR_BEGIN/END); allow plug + user-defined.
  if (!category || category.userId !== session.user.id) notFound();
  if (category.isBuiltIn && category.slug !== "plug") notFound();

  // Block if a session is already active in this category
  const active = await getActiveWearSessionForCategory(session.user.id, categoryId);
  if (active) redirect(`/dashboard/new/wear-end?category=${categoryId}`);

  const devices = await prisma.device.findMany({
    where: { userId: session.user.id, categoryId, archivedAt: null },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, name: true },
  });

  // Verlangt eine Aufgabe ein BESTIMMTES Gerät, steht es vorne — `WearForm` wählt das erste vor.
  // Bewusst nur umsortiert und nicht gefiltert: die Vorgabe soll führen, nicht die freie Wahl
  // ersetzen (und ein Gerät, das es nicht mehr gibt, darf das Formular nicht leer machen).
  const preferred = devices.findIndex((d) => d.id === wantedDevice);
  if (preferred > 0) devices.unshift(...devices.splice(preferred, 1));

  // Aus einer Wear-Anforderung geöffnet (Fork): Gerät fest vorwählen + sperren, Foto-Pflicht ggf.
  // überschreiben. Der Server erzwingt beides ebenfalls (POST /api/entries, WEAR_BEGIN).
  let forcedDeviceId: string | null = null;
  let requirePhoto = category.requirePhoto;
  if (anforderungId) {
    const anf = await prisma.verschlussAnforderung.findFirst({
      where: { id: anforderungId, userId: session.user.id, deviceCategoryId: categoryId, art: "ANFORDERUNG", fulfilledAt: null, withdrawnAt: null },
      select: { deviceId: true, fotoPflicht: true },
    });
    if (anf) {
      forcedDeviceId = anf.deviceId;
      if (anf.fotoPflicht !== null) requirePhoto = anf.fotoPflicht;
    }
  }

  const [t, mobileDesktopMode] = await Promise.all([
    getTranslations("wearForm"),
    getMobileDesktopMode(session.user.id),
  ]);

  // Kopf einmal, für beide Ausgänge unten: der Leerfall ist derselbe Bildschirm, nur ohne Geräte —
  // ein zweiter, von Hand gleich gehaltener Kopf wäre genau die Stelle, an der die zwei
  // auseinanderlaufen.
  const shell = { ...actionSign("WEAR_BEGIN"), title: t("titleBegin") };

  // Auch der Leerfall bekommt Kopf und Titel. Vorher stand hier eine Seite aus Rücklink und Kasten,
  // ohne zu sagen, WELCHE Handlung gerade nicht möglich ist — nur der Kategorie-Name im Satz
  // verriet es.
  if (devices.length === 0) {
    return (
      <EntryActionFormShell {...shell}>
        <div className="p-6 rounded-xl border border-border bg-surface text-center">
          <p className="text-fliess text-foreground-muted mb-3">{t("noDevicesInCategory", { name: category.name })}</p>
          <Link href={deviceFormHref(category.id)} className="text-fliess font-medium text-foreground underline">
            {t("addDeviceLink")}
          </Link>
        </div>
      </EntryActionFormShell>
    );
  }

  return (
    <EntryActionFormShell {...shell}>
      <WearForm
        kind="begin"
        mobileDesktopMode={mobileDesktopMode}
        category={{ id: category.id, name: category.name, color: category.color, icon: category.icon, requirePhoto }}
        devices={devices}
        redirectTo={target}
        forcedDeviceId={forcedDeviceId}
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
      />
    </EntryActionFormShell>
  );
}
