# Umsetzungs-Dokument — „Tag antippen → Kontrollanforderung öffnen" (Universal Link)

**Stand 2026-07-31** · Ziel-App: KG-Tracker (`chastitytracker`, Capacitor + Next.js) · Gegenstelle: Airtracker / Airlock-Generator (`Airlock3DSTLGenerator`) · Domain `nfc.neurorelatepoly.app` · App-ID `V25J9329BP.sw.chastitytracker.app`

Dieses Dokument ist die **verifizierte** Umsetzungsvorlage: es benennt die konkreten Dateien und
Funktionen im aktuellen Code (statt Pseudocode) und trennt sauber, **was im KG-Tracker gebaut wird**
(Teil A) und **was an die Airtracker-Seite zurückkommuniziert werden muss** (Teil B). Grundlage ist die
Prüfung der Übergabe „KGTrackerUebergabeUniversalLink" gegen den echten Repo-Stand.

---

## 0. Ergebnis der Code-Prüfung (Kurzfassung)

| Annahme aus der Übergabe | Status im Code | Fundstelle |
|---|---|---|
| Universal-Link-Ziel = `V25J9329BP.sw.chastitytracker.app` | **stimmt** — Bundle `sw.chastitytracker.app`, Team `V25J9329BP` | `ios/App/App.xcodeproj/project.pbxproj` |
| `@capacitor/app` verfügbar (`appUrlOpen`/`getLaunchUrl`) | **ja, v8.1.0** als Dependency — aber **nirgends verwendet** → sauberes Greenfield | `package.json` |
| Associated Domains fehlt noch | **korrekt** — Entitlement hat nur `aps-environment` + NFC `[TAG]` | `ios/App/App/App.entitlements` |
| NFC bleibt TAG-only → kein Reject 90778 | **korrekt**, unverändert | `App.entitlements` |
| Code → Lock nachschlagbar | **ja** — `prisma.airlockLock.findUnique({ where: { code } })` existiert | `src/lib/airlock/service.ts` |
| „max. 1 offene Anforderung" | **pro Gerät bereits durchgesetzt** (ALREADY_ACTIVE-Guard), global nicht — siehe §A.1 | `src/lib/kontrolleService.ts` |

**Fazit: umsetzbar, ohne NFC-Umbau und ohne DB-Migration.** Alle benötigten Felder und Lookups
existieren. Zu bauen sind vier kleine, klar abgegrenzte Teile (§A.2–A.5).

---

# Teil A — Umsetzung im KG-Tracker

## A.1 Entscheidung „max. 1 offene Anforderung" (festgelegt: pro Gerät)

Die Übergabe (§5) behandelt den Fall „mehrere offene Anforderungen → jüngste vorschlagen". Im Code
gibt es dafür bereits einen bewussten Schutz in `requestKontrolle` (`src/lib/kontrolleService.ts`):

```
if (await hasActiveKontrolle(userId, now, { tx, device: dev })) {
  throw fail("ALREADY_ACTIVE");   // → INSPECTION_ALREADY_ACTIVE
}
```

Der Kommentar dort ist explizit: *„Cage und Plug dürfen weiterhin parallel kontrolliert werden."*
Das heißt:

- **Pro Gerät** (CAGE bzw. PLUG) ist „höchstens eine aktive Kontrolle" **schon jetzt** garantiert.
- **Global pro Sub** ist es bewusst *nicht* garantiert — eine CAGE- und eine PLUG-Kontrolle dürfen
  gleichzeitig offen sein. Das ist ein gewolltes Feature, kein Bug.

**Festlegung (Stefan, 31.07.2026): pro Gerät beibehalten.** Für das Airlock-/Universal-Link-Feature
ist das unkritisch, weil ein Airlock-Lock **immer ein Käfig (CAGE)** ist. Der Routing-Schritt filtert
deshalb gezielt auf `device: "CAGE"` — und für CAGE gilt durch den bestehenden Guard praktisch
„höchstens eine offene". Der „mehrere → jüngste"-Zweig aus §5 wird damit zu einem reinen
Absicherungs-Fallback (`orderBy createdAt desc`, praktisch unerreichbar), **kein** Code-Umbau der
Invariante nötig.

> Konsequenz: In diesem Dokument wird die Invariante **nicht** verändert. Wer sie dennoch global
> ziehen wollte, müsste den `device`-Parameter aus `hasActiveKontrolle` entfernen — das bräche die
> CAGE/PLUG-Parallelität und ist hier ausdrücklich **nicht** vorgesehen.

## A.2 Änderung 1 — Associated Domains (iOS-Entitlement)

Datei `ios/App/App/App.entitlements` — den Associated-Domains-Schlüssel ergänzen, **NFC unverändert
TAG-only lassen**:

```xml
<key>com.apple.developer.associated-domains</key>
<array>
    <string>applinks:nfc.neurorelatepoly.app</string>
</array>
```

In Xcode entsteht das über App-Target → Signing & Capabilities → „+ Capability" → Associated Domains.
Team `V25J9329BP` und Bundle `sw.chastitytracker.app` sind bereits gesetzt; die Capability zieht beim
Hinzufügen i. d. R. automatisch ins Provisioning. Bei headless/manueller Signierung das Entitlement in
die Signier-Entitlements aufnehmen.

> `capacitor.config.ts` → `server.allowNavigation` **nicht** um `nfc.neurorelatepoly.app` erweitern.
> Der Universal Link wird von iOS abgefangen und als *Event* an die App übergeben; die WebView darf
> gar nicht erst dorthin navigieren.

## A.3 Änderung 2 — Deep-Link-Listener (JS-Layer, neues Client-Component)

`@capacitor/app` ist als Dependency vorhanden, wird aber noch nicht genutzt. Das ideale Muster liegt
bereits im Repo: **`src/app/components/NativePushRouter.tsx`** — ein `"use client"`-Component, das
app-weit im Layout gemountet ist, ein natives Event abhört und die WebView per
`window.location.href` auf einen **relativen** Pfad navigiert (z. B. `/dashboard/new/pruefung?code=…`).
Der Deep-Link-Handler spiegelt dieses Muster 1:1.

Neues Component **`src/app/components/AirlockDeepLinkRouter.tsx`**:

```tsx
"use client";

import { useEffect } from "react";
import { isNativePlatform } from "@/lib/nativePush";

const TAG_HOST = "nfc.neurorelatepoly.app";

/**
 * Öffnet beim Antippen eines Airlock-Tags (Universal Link) die passende Kontroll-Anforderung
 * INNERHALB der App. Spiegelt das Muster von NativePushRouter: nativer Event → same-origin-Navigation.
 * Die eigentliche Auflösung Code → Lock → offene Kontrolle macht der Server (siehe A.4), damit
 * kein Prisma/Server-Modul in den Client gezogen wird (Client/Server-Grenze, vgl. CLAUDE.md).
 */
export default function AirlockDeepLinkRouter() {
  useEffect(() => {
    let remove: (() => void) | null = null;
    let cancelled = false;

    function handleTagUrl(rawUrl: string): void {
      let url: URL;
      try { url = new URL(rawUrl); } catch { return; }
      if (url.hostname !== TAG_HOST) return;
      const m = url.pathname.match(/^\/t\/([^/]+)\/?$/);   // exakt /t/<code>
      if (!m) return;
      const code = decodeURIComponent(m[1]);
      // Auflösung + Redirect macht der Server; wir übergeben nur den Code (re-enkodiert).
      window.location.href = `/airlock/open?code=${encodeURIComponent(code)}`;
    }

    (async () => {
      try {
        if (!(await isNativePlatform())) return;
        const { App } = await import("@capacitor/app");
        // Warm-Start (App läuft): appUrlOpen
        const handle = await App.addListener("appUrlOpen", (event) => handleTagUrl(event.url));
        if (cancelled) handle.remove();
        else remove = () => handle.remove();
        // Kalt-Start (App durch den Link gestartet): einmalig getLaunchUrl
        const launch = await App.getLaunchUrl();
        if (launch?.url) handleTagUrl(launch.url);
      } catch (err) {
        console.error("[AirlockDeepLinkRouter]", err);
      }
    })();

    return () => { cancelled = true; remove?.(); };
  }, []);

  return null;
}
```

Mounten in **`src/app/layout.tsx`**, direkt neben dem bestehenden `<NativePushRouter />` (aktuell
Zeile 123) — dadurch ist der Listener auch beim Kaltstart aktiv:

```tsx
import AirlockDeepLinkRouter from "@/app/components/AirlockDeepLinkRouter";
// …
<NativePushRouter />
<AirlockDeepLinkRouter />
```

## A.4 Änderung 3 — Server-Auflösung Code → Lock → offene Kontrolle (neuer Route Handler)

**Warum server-seitig:** Die Auflösung braucht Prisma und die Session — beides darf **nicht** in ein
`"use client"`-Modul (bekannte Falle im Projekt: „use client darf keine server-only Module ziehen",
fällt erst im vollen `next build` auf). Der Client (A.3) navigiert deshalb nur auf einen internen
Pfad; die Logik lebt server-seitig.

Neuer Route Handler **`src/app/airlock/open/route.ts`** (GET, gibt `redirect(...)` zurück). Er nutzt
ausschließlich vorhandene Bausteine:

- Lock-Lookup: `prisma.airlockLock.findUnique({ where: { code } })` (wie in `src/lib/airlock/service.ts`).
- Offene, aktive **CAGE**-Kontrolle: identisch zu `getOpenKontrolle` in `src/lib/queries.ts`, nur
  zusätzlich auf `device: "CAGE"` gefiltert.
- „Aktiv"-Gate: `aktiveKontrolleWhere(now)` = `{ OR: [{ wirksamAb: null }, { wirksamAb: { lte: now } }] }`
  (blendet geplante, noch nicht ausgelöste Kontrollen aus).
- „Offen" = `entryId: null` (noch keine erfüllende PRUEFUNG) **und** `withdrawnAt: null`.

Soll-Logik (an die vorhandene Session-Auflösung der übrigen `/api`-Routen anlehnen):

```ts
// GET /airlock/open?code=<airlockCode>
const user = await getSessionUser();                 // wie in den bestehenden Routen
if (!user) redirect(`/login?returnUrl=${encodeURIComponent(`/airlock/open?code=${airlockCode}`)}`);

const lock = await prisma.airlockLock.findUnique({ where: { code: airlockCode } });

// Unbekannter Code ODER Lock gehört nicht dem antippenden Sub → neutraler Home, KEIN Fehler/Popup.
if (!lock || lock.assignedUserId !== user.id) redirect("/");

const now = new Date();
const open = await prisma.kontrollAnforderung.findFirst({
  where: { userId: user.id, device: "CAGE", entryId: null, withdrawnAt: null, ...aktiveKontrolleWhere(now) },
  orderBy: { createdAt: "desc" },                    // „jüngste" — praktisch ohnehin max. 1 (A.1)
});

if (!open) redirect("/");                            // keine offene Anforderung → Standard-Home
redirect(`/dashboard/new/pruefung?code=${encodeURIComponent(open.code)}`);
```

Das Ziel `/dashboard/new/pruefung?code=…` ist exakt der Pfad, den auch der Push-Tap heute anspringt
(siehe `NativePushRouter`) — die bestehende Prüfungs-/Foto-Seite des Subs. **Die Echtheitsprüfung
(In-App-UID-Scan) bleibt dort unverändert**; der Link identifiziert nur *welche* Anforderung, er ist
**kein** Echtheitsnachweis.

> **Wichtiger Zusatz gegenüber der Übergabe:** Der Ownership-Check `lock.assignedUserId === user.id`
> fehlte im Pseudocode (§5), ist aber essenziell. Die WebView ist bereits als *irgendein* Sub
> eingeloggt; ohne den Check könnte ein fremder Code eine nicht zugehörige Session-Sicht anspringen.
> Gehört der Code nicht dem eingeloggten Sub → neutraler Home (deckt zugleich „unbekannter Code" ab).

## A.5 Kantenlogik (final, gegen den Code abgeglichen)

| Fall | Verhalten | Umsetzung |
|---|---|---|
| Genau **eine** offene CAGE-Anforderung | direkt in die Prüfung springen | `redirect(/dashboard/new/pruefung?code=…)` |
| **Keine** offene Anforderung | Standard-Home, kein Popup | `redirect("/")` |
| **Mehrere** (praktisch nur, wenn eine CAGE abgelaufen + eine neu) | jüngste offene | `orderBy createdAt desc` + `findFirst` |
| **Unbekannter** Code / **fremdes** Lock | neutraler Home, kein Crash | `!lock || assignedUserId !== user.id → redirect("/")` |
| **Nicht eingeloggt** (Kaltstart vor Login) | Login, danach neutral | `redirect("/login?returnUrl=…")` — Code geht ggf. verloren → Home; optional per `returnUrl` zurückführen |

## A.6 Test (KG-Tracker-Seite)

1. Build **mit** Associated-Domains-Entitlement auf ein **echtes Gerät** (Universal Links laufen im
   Simulator nicht zuverlässig).
2. **Ohne Tag:** `https://nfc.neurorelatepoly.app/t/12345` in eine **Notiz/iMessage** schreiben und
   **antippen** → App öffnet, Server löst auf. (Direkt in Safari eingeben zählt nicht — das öffnet die
   Web-Fallback-Seite.)
3. Kantenfälle durchspielen: eine/keine offene CAGE-Kontrolle, fremder/unbekannter Code, ausgeloggt.
4. **AASA-Cache umgehen** (schnelleres Testen): temporär `applinks:nfc.neurorelatepoly.app?mode=developer`
   + Developer Mode am iPhone; vor Release wieder auf `applinks:nfc.neurorelatepoly.app`. Alternativ
   App neu installieren.
5. Mit echtem Tag erst testbar, sobald die Airtracker-Seite den URL-Record schreibt (Teil B).

## A.7 Checkliste KG-Tracker

- [ ] `App.entitlements`: `applinks:nfc.neurorelatepoly.app` ergänzt, NFC bleibt `[TAG]`.
- [ ] `AirlockDeepLinkRouter.tsx` angelegt (`appUrlOpen` + `getLaunchUrl`, Host- + `^/t/<code>$`-Parse).
- [ ] In `layout.tsx` neben `NativePushRouter` gemountet.
- [ ] Route Handler `src/app/airlock/open/route.ts`: Session → Lock-Lookup → Ownership → offene CAGE-Kontrolle → Redirect.
- [ ] Offen-Query wie `getOpenKontrolle` + `device: "CAGE"` + `aktiveKontrolleWhere`.
- [ ] Ziel-Redirect `/dashboard/new/pruefung?code=…` (Echtheits-UID-Scan dort unverändert).
- [ ] `allowNavigation` **nicht** um die Tag-Domain erweitert.
- [ ] Auf echtem Gerät getestet (Link aus Notiz; echter Tag nach Teil B).
- [ ] `next build` (voll) grün — fängt Client/Server-Import-Fehler, die `tsc` allein nicht sieht.

---

# Teil B — Rückkommunikation an die Airtracker-App (Airlock-Generator/Writer)

Das Feature wirkt **nur** bei Tags, die den URL-Record tragen. Das ist eine reine
**Generator-/Writer-Änderung** im Airtracker-Repo (`Airlock3DSTLGenerator`) — im KG-Tracker ist dafür
nichts zu tun. Folgendes muss dort umgesetzt bzw. bestätigt werden:

## B.1 Tag-Layout — zwei NDEF-Records, URI zuerst

Jeder Tag bekommt **zwei** Records in dieser Reihenfolge:

1. **URI-Record** (neu): `https://nfc.neurorelatepoly.app/t/<code>`
2. **Text-Record** (bestehend, „T"): `AL1|<code>|<token>`

## B.2 Identitäts-Vertrag `<code>` (kritisch)

Der `<code>` in der URL **muss** die **5-stellige Airlock-Nummer** sein — dieselbe, die der KG-Tracker
als `AirlockLock.code` (Unique-Key) speichert und über die er das Lock nachschlägt. **Nicht** der
Token, **nicht** die UID. Weicht der URL-Code vom Airlock-Code ab, findet der KG-Tracker das Lock nicht
und landet auf Home. Dieser Vertrag ist der einzige harte Kopplungspunkt zwischen beiden Apps.

## B.3 Konkrete Änderungen Airtracker-Seite

- **`nfc/prepare`** liefert zusätzlich die URL bzw. die vollständige Record-Liste (URI + Text).
- **Writer-App** schreibt **beide** Records (URI zuerst, dann `AL1|code|token`).
- **Config:** `AIRLOCK_TAG_URL_BASE=https://nfc.neurorelatepoly.app` im `environment:`-Block der
  `docker-compose.yml` (kein `env_file`).
- **Writer-Signierung/Entitlement:** falls die Writer-App eigenständig signiert wird — **TAG-only-NFC
  beibehalten**; für das reine *Schreiben* ändert sich am NFC-Entitlement nichts.

## B.4 Rückwärtskompatibilität (bereits gegeben, nur zur Bestätigung)

- Der KG-Tracker-**Reader** sucht den Record gezielt über den Well-Known-Typ **„T"**
  (`firstTextRecord`) und **überspringt** den URI-Record → **keine** Reader-Änderung, **keine**
  Regression. Alt-Tags (nur Text-Record) funktionieren im KG-Tracker weiter per In-App-Scan, öffnen
  die App aber nicht per Antippen (erwartet).
- Der **Verify-Flow** (`nfc/verify`) und die API-Keys bleiben unverändert.

## B.5 Bereits erledigt (kein Handlungsbedarf)

- **AASA live & geprüft:** `https://nfc.neurorelatepoly.app/.well-known/apple-app-site-association`
  liefert gültiges JSON mit `appIDs: ["V25J9329BP.sw.chastitytracker.app"]`, Content-Type
  `application/json`, kein Redirect.
- **NFC-Reader-Fix:** `queryNDEFStatus`-Priming vor `readNDEF` in `Nfc.swift` — erledigt.

## B.6 Checkliste Airtracker

- [ ] `nfc/prepare` liefert URL/Record-Liste.
- [ ] Writer schreibt zwei Records (URI zuerst, dann `AL1|code|token`).
- [ ] `<code>` in der URL = 5-stellige Airlock-Nummer (= `AirlockLock.code`).
- [ ] `AIRLOCK_TAG_URL_BASE` in `docker-compose.yml` (`environment:`, kein `env_file`).
- [ ] Writer-Signierung: NFC bleibt TAG-only.
- [ ] Ein Testtag mit URL-Record geschrieben und an KG-Tracker (echtes Gerät) gegengetestet.

---

## Anhang — Fundstellen (verifiziert am 31.07.2026)

- Bundle/Team: `ios/App/App.xcodeproj/project.pbxproj` (`PRODUCT_BUNDLE_IDENTIFIER = sw.chastitytracker.app`, `DEVELOPMENT_TEAM = V25J9329BP`)
- Entitlement: `ios/App/App/App.entitlements`
- Capacitor-Deps: `package.json` (`@capacitor/app ^8.1.0`)
- Navigations-Muster: `src/app/components/NativePushRouter.tsx`
- Layout-Mount: `src/app/layout.tsx` (Zeile 123)
- Lock-Lookup + Zuweisung: `src/lib/airlock/service.ts` (`findUnique({ where: { code } })`, `getAssignedLocks`, `getActiveAirlockCode`)
- Offene Kontrolle: `src/lib/queries.ts` (`getOpenKontrolle`, `aktiveKontrolleWhere`)
- Gerät-Guard „max. 1 pro Gerät": `src/lib/kontrolleService.ts` (`hasActiveKontrolle` → `INSPECTION_ALREADY_ACTIVE`)
- Verify-Flow (unverändert): `src/app/api/airlock/verify/route.ts`, `src/lib/airlock/verify.ts`
