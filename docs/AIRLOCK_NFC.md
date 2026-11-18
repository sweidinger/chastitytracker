# Airlock-NFC: Kontext & Implementierungsauftrag (für Claude Code)

> **Zweck dieser Datei:** Sie fasst zusammen, wie die **Airlock3DSTLGenerator**-App
> funktioniert und wie deren **NFC-Echtheits-/Kopierschutz** aufgebaut ist, damit
> in *diesem* Projekt (dem KG-Tracker bzw. der nativen App) die **Lese- und
> Verifikationsseite** implementiert werden kann.
>
> Legt die Datei am besten als `docs/AIRLOCK_NFC.md` ab und referenziert sie aus
> der bestehenden `CLAUDE.md` (nicht die vorhandene `CLAUDE.md` überschreiben).

---

## 1. Die zwei Apps im Zusammenspiel

Es gibt zwei getrennte Systeme:

- **Airlock3DSTLGenerator** (Repo `sweidinger/Airlock3DSTLGenerator`, aktuell
  **v1.5.0**) – ein eigenständiger Docker-Container, der 3D-druckbare „AirLocks"
  (Einweg-Schlösser) erzeugt. Jeder Lock trägt eine eindeutige **5-stellige
  Nummer** und – neu ab v1.5.0 – einen eingebetteten **NFC-Tag** als Fälschungs-
  und Kopierschutz. Das ist der **Producer**: er *schreibt* die Tags.

- **Dieses Projekt** (KG-Tracker / native App) – der **Consumer**: es soll die
  Tags später **lesen und verifizieren**, um zu bestätigen, dass ein physischer
  Lock echt und nicht dupliziert ist.

**Gewählte Architektur (verbindlich):** Die **Airlock-App ist immer online und
Source of Truth** — sie führt die gesamte Echtheits-, UID-Bindungs- und
Status-/Lock-Validierung durch (über ihre Registry). Die **KG-Tracker-App ist nur
das Frontend**: sie liest den Tag (UID + NDEF), ruft die Airlock-Verify-API auf und
zeigt das Ergebnis an. Keine Krypto und keine Registry-Datenhaltung im KG-Tracker.
→ Das ist **Weg A** (siehe Abschnitt 4). Weg B (Offline-HMAC) ist nur als
Referenz dokumentiert und wird **nicht** umgesetzt.

**Aufgabenteilung konkret:**

- **Airlock-App** (Betreiber, nicht der KG-Tracker): erzeugt Locks, druckt sie,
  beschreibt den NFC-Tag (`prepare`/`commit`), führt die Registry und den Status.
  Das ist die **einzige** Stelle, an der Locks entstehen — der KG-Tracker
  **generiert nichts mehr**.
- **KG-Tracker-Frontend** (die „AI-Keyholderin"): (1) zeigt die **verfügbaren**
  Locks an, die die Airlock-App bereits erstellt/gedruckt und mit Tag versehen hat;
  (2) lässt die Keyholderin eines auswählen und auf **`active`** setzen; (3) sendet
  bei einer **Prüf-Anforderung** UID + Token an die Airlock-`verify`-API und zeigt
  das Ergebnis. Der KG-Tracker kennt **keine Codes-Vergabe und keine Krypto**.
- **Wer kennt was:** Die Airlock-App kennt nur **Codes + Status + UID-Bindung** —
  keine Nutzer:innen. Die Zuordnung „welches aktive Lock gehört zu welcher
  Person/Session" liegt **im KG-Tracker**.

**Zugriff:** Der KG-Tracker nutzt einen **gesonderten, eingeschränkten
KG-Tracker-Key** (nicht den vollen Airlock-Key). Rechte: **Lesen** (`GET
/v1/airlocks*`) + **Statuswechsel** (`PATCH /v1/airlocks/{code}`) + **`verify`** —
**nicht** generieren, keine STL/3MF-Downloads, kein Tag-Schreiben. Dieser Key wird
im **KG-Tracker-Backend** gehalten (nie im App-/Browser-Frontend).

> **Airlock-Gegenstück (kommt als v1.6.0):** gesonderter `AIRLOCK_KG_API_KEY`
> (obige Rechte), optionaler Filter `GET /v1/airlocks?available=true` und optionaler
> Parameter `require_status` bei `verify`. Die Contracts stehen unten — der
> KG-Tracker kann **parallel** dagegen gebaut werden.

---

## 2. Was der Airlock3DSTLGenerator tut (Funktionsweise)

- **Stack:** Python **FastAPI** + **SQLite**-Registry, Rendering über **OpenSCAD**
  (headless, `--export-format binstl`). Läuft als Docker-Container, Web-Dashboard
  unter `/`.
- **Generierung:** prägt eine erhabene 5-stellige Nummer per OpenSCAD-Vorlage
  (`DisposableLock_v2`) in das Lock-Modell. Batch-Erzeugung mit Auto-Vergabe
  zufälliger Codes (`secrets.randbelow`) oder vorgegebenen Codes; Einzel-STL,
  ZIP-Batch, Idempotenz.
- **Mehrfarb-Druckdateien (Bambu Lab X1/P1/A1):** Export als **3MF** (Farbe pro
  Dreieck über die 3MF-Material-Erweiterung `m:colorgroup`) oder **OBJ**
  (Per-Vertex-Farbe). Schloss schwarz, Nummer weiß, im Raster auf 256×256-mm-
  Bauplatte. Beide färben *alle* Locks eines Batches korrekt.
- **Status-Lebenszyklus** je Airlock (SQLite):
  `reserved → generated → printed → registered → active → retired | voided`.
- **Auth:** API-Key pro Instanz (`AIRLOCK_API_KEY`), als Header
  `X-API-Key: <key>` **oder** `Authorization: Bearer <key>`.
- **NFC (v1.5.0):** In jeden gedruckten Lock wird ein **NTAG213/215/216**-Tag
  eingelegt (Aussparung in der Vorlage). Der Generator beschreibt den Tag mit
  einem signierten Token, der an die Hardware-UID des Tags gebunden ist, und
  speichert die UID in der Registry. **Das ist der Teil, den dieses Projekt
  gegenprüfen muss.**

---

## 3. Der NFC-Schutz: Bedrohungsmodell & Kryptografie

Die geprägte Nummer allein schützt nicht gegen **Duplizieren** (die gespeicherte
Druckdatei mehrfach drucken). Der NFC-Tag schließt die Lücke, weil jeder NTAG
eine **ab Werk eindeutige, unveränderliche UID** hat.

Zwei Angriffe, zwei Abwehrmechanismen:

| Angriff | Beschreibung | Abwehr |
|---|---|---|
| **Fälschung** | gültige Nummer *erfinden* | signierter Token – ohne `secret` nicht erzeugbar |
| **Duplizieren** | gültige Nummer *kopieren* | Token ist an **eine** UID gebunden; Nachdruck hat andere UID; Registry hält einen Code nur für **eine** aktive Schließung |

Rest-Risiko: „magic tags" mit änderbarer UID. Dagegen greift die Registry-Einmal-
Logik + UID-Bindung.

### Tag-Inhalt (NDEF Text-Record)

```
AL1|<code>|<token>
```

- `code` — 5-stellige Airlock-Nummer.
- `token` — `HMAC_SHA256(secret, "<code>|<UID>")`, die ersten **32 Hex-Zeichen**
  (128 Bit), **Kleinschreibung**.
- `UID` — Tag-UID als Hex, **Großbuchstaben, ohne Trenner** (z. B.
  `04A1B2C3D4E580`).

`secret` = `AIRLOCK_NFC_SECRET`. Muss im Generator **und** hier identisch gesetzt
sein, wenn offline (ohne Generator-API) verifiziert wird.

### Referenz-Algorithmus (exakt wie im Generator, `app/nfc.py`)

```
normalize_uid(uid):
    u = uid  ohne alle Nicht-Hex-Zeichen, dann UPPERCASE
    gültig nur wenn  8 <= len(u) <= 20  und  len(u) gerade
    sonst Fehler

sign(code, uid, secret):
    u = normalize_uid(uid)
    return HMAC_SHA256(secret, f"{code}|{u}").hexdigest()[:32]     # lower-case hex

verify(code, uid, token, secret):
    return sign(code, uid, secret) == token.strip().lower()

parse_ndef_text("AL1|code|token") -> (code, token)   # 3 Teile, erstes == "AL1"
```

### ⚠️ Der wichtigste Fallstrick: UID-Byte-Reihenfolge

`normalize_uid` entfernt nur Trennzeichen und macht Großbuchstaben — es **dreht
die Byte-Reihenfolge nicht**. Der Token bindet also die UID *in genau der
Reihenfolge*, in der sie beim Schreiben vorlag. Verschiedene Plattformen liefern
die UID aber unterschiedlich:

- **Web NFC** (Android/Chrome, Schreibseite): `NDEFReader` liefert `serialNumber`
  als `xx:xx:...` in „natürlicher" Reihenfolge (Byte 0 = Herstellerbyte zuerst).
- **iOS Core NFC** und manche Android-Libs liefern die UID **umgekehrt** (das war
  z. B. ein dokumentierter Bug im Capawesome-Plugin: „It's the same UID, it's
  just reversed").

**Folge:** Wird auf Android geschrieben und auf iOS gelesen (oder umgekehrt),
schlägt die Signaturprüfung fehl, obwohl der Tag echt ist.

**Lösung / verbindliche Regel für die Leseseite:** Immer auf **eine kanonische
Reihenfolge** normalisieren, bevor `sign/verify` gerufen wird. Empfehlung: die
auf dem Tag aufgedruckte Reihenfolge = NFC-Übertragungsreihenfolge, **Byte 0
zuerst**. Praktische Heuristik: Die UID eines NTAG beginnt **immer mit `04`**
(NXP-Herstellercode). Wenn die gelesene, normalisierte UID **nicht** mit `04`
beginnt, ist die Byte-Reihenfolge vermutlich gedreht → paarweise Bytes umkehren
und erneut prüfen.

```
def canonical_uid(raw_hex):
    u = normalize_uid(raw_hex)
    if not u.startswith("04"):
        u = "".join(reversed([u[i:i+2] for i in range(0, len(u), 2)]))
    return u
```

> Beim ersten Hardware-Test mit einem echten Tag einmal verifizieren, dass
> Schreib- und Leseseite dieselbe kanonische UID erzeugen.

---

## 4. Was in DIESEM Projekt zu implementieren ist

### 4.1 Ablauf im Überblick (Keyholder-Frontend)

1. **Verfügbare Locks anzeigen** — Liste der bereits gedruckten, getaggten,
   noch freien Locks aus der Airlock-App holen (4.2).
2. **Auswählen & aktivieren** — Keyholderin wählt ein Lock; der KG-Tracker setzt
   es per Statuswechsel auf `active` und merkt sich intern die Zuordnung
   Lock ↔ Nutzer:in/Session (4.3).
3. **Prüf-Anforderung** — beim Scannen des physischen Locks: Tag lesen (4.4) und
   gegen die Airlock-`verify`-API prüfen (4.5), Ergebnis anzeigen.

Alle Airlock-Aufrufe laufen über das **KG-Tracker-Backend** (hält den
KG-Tracker-Key), nicht direkt aus dem Frontend.

### 4.2 Verfügbare Locks anzeigen

`GET /v1/airlocks` liefert je Lock u. a. `code`, `status`, `nfc_uid`,
`nfc_written_at`. **„Verfügbar"** = Tag gebunden (`nfc_uid` ≠ null) **und** Status
noch frei (nicht `active`/`retired`/`voided`).

- **Heute schon** möglich: `GET /v1/airlocks` holen und clientseitig filtern.
- **Ab Airlock v1.6.0** bequemer: `GET /v1/airlocks?available=true` liefert direkt
  nur die auswählbaren Locks.

### 4.3 Lock auswählen & aktivieren

Statuswechsel auf `active`:

```
PATCH /v1/airlocks/{code}
Header: X-API-Key: <KG-Tracker-Key>
Body:   { "status": "active" }
→ 200 AirlockOut (mit neuem Status)   |   404 unbekannter Code   |   422 ungültiger Status
```

Erlaubte Statuswerte: `reserved, generated, printed, registered, active, retired,
voided`. Für den KG-Tracker relevant sind v. a. `active` (in Benutzung) und
`retired` (freigegeben/entwertet). Die Zuordnung, **welche Nutzer:in** dieses aktive
Lock trägt, speichert der KG-Tracker selbst — die Airlock-App weiß davon nichts.

### 4.4 Tag lesen

Aus dem physischen Tag zwei Dinge holen:

1. **UID** (Hardware, aus der Tag-Identifikation — nicht aus dem NDEF-Inhalt!).
2. **NDEF-Text** `AL1|<code>|<token>` → mit `parse_ndef_text` in `code` + `token`
   zerlegen.

### 4.5 Prüf-Anforderung: Verifizieren

> **Umzusetzen ist Weg A.** Weg B steht nur als Referenz darunter und wird für
> dieses Projekt nicht gebaut.

**Weg A – Airlock-API aufrufen** (die Airlock-Instanz ist immer erreichbar):

```
POST {generator_base}/v1/airlocks/{code}/nfc/verify
Header: X-API-Key: <KG-Tracker-Key>        (oder Authorization: Bearer <key>)
Body:   { "uid": "<hardware-uid>", "token": "<token-aus-ndef>" }
```

**Muss es das *aktive* Lock sein?** `verify` blockt aktuell nur `retired`/`voided`,
nicht „muss `active` sein". Zwei Wege, das „ist in Benutzung"-Kriterium zu prüfen:

- **Einfach, heute:** Der KG-Tracker liest das `status`-Feld aus der Antwort und
  akzeptiert nur `status == "active"`.
- **Ab Airlock v1.6.0:** optionaler Body-Parameter `"require_status": "active"` →
  bei Abweichung Antwort `{ "valid": false, "reason": "status_mismatch", "status": "<ist>" }`.

Antwort:
```
{ "valid": true,  "code": "12345", "uid": "04A1...", "status": "active", "bound_uid": "04A1..." }
{ "valid": false, "reason": "<siehe unten>", ... }
```

`reason`-Werte: `unknown_code`, `bad_uid`, `bad_signature`, `uid_mismatch`
(mit `bound_uid`), `status_retired`, `status_voided`, `status_mismatch` (nur mit
`require_status`, ab v1.6.0).

> **⚠️ Betrieb & Sicherheit für Weg A (wichtig):**
> - **Nur den KG-Tracker-Key benutzen, und nur im Backend.** Der KG-Tracker nutzt
>   den eingeschränkten `AIRLOCK_KG_API_KEY` (Lesen + Statuswechsel + `verify`; ab
>   v1.6.0), **nicht** den vollen `AIRLOCK_API_KEY`. Auch der eingeschränkte Key
>   gehört ausschließlich ins **KG-Tracker-Backend**, nie ins App-/Browser-Frontend.
>   Kette: **Frontend → KG-Tracker-Backend (hält den Key) → Airlock-API**. So bleibt
>   „Frontend zeigt nur an" erhalten, und CORS entfällt (Server-zu-Server).
> - **Erreichbarkeit/HTTPS:** Die Airlock-Instanz muss von dort, wo verifiziert
>   wird, erreichbar sein (ggf. NAS-Dienst per HTTPS/Tunnel/VPN veröffentlichen).
>   Da „immer online" gewählt ist, ist diese Abhängigkeit bewusst akzeptiert —
>   Frontend sollte einen klaren Fehlerzustand zeigen, wenn die Airlock-App gerade
>   nicht erreichbar ist.
> - **Lock-Lebenszyklus** (aktivieren/sperren) läuft über `PATCH
>   /v1/airlocks/{code}` — die Airlock-App bleibt Source of Truth, der KG-Tracker
>   triggert nur.

---

**Weg B – Offline** *(nur Referenz — für dieses Projekt NICHT umgesetzt; braucht
`AIRLOCK_NFC_SECRET`):*

1. `token == HMAC_SHA256(secret, "<code>|<canonical_uid>")[:32]` prüfen
   (zeitkonstant vergleichen).
2. Zusätzlich sicherstellen, dass die UID die für diesen `code` **registrierte**
   ist und der Status nicht `retired`/`voided` — d. h. gegen die eigene
   Datenhaltung/Registry prüfen (die native App bzw. das KG-Tracker-Backend muss
   die Code↔UID-Bindung kennen, entweder aus eigener DB oder einmalig vom
   Generator synchronisiert).

TypeScript-Referenz (passt 1:1 zum Generator):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function normalizeUid(uid: string): string {
  const u = (uid || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (u.length < 8 || u.length > 20 || u.length % 2 !== 0)
    throw new Error(`Ungültige UID: ${uid}`);
  return u;
}

export function canonicalUid(rawHex: string): string {
  let u = normalizeUid(rawHex);
  if (!u.startsWith("04")) {
    u = u.match(/.{2}/g)!.reverse().join("");   // Byte-Reihenfolge drehen
  }
  return u;
}

export function signToken(code: string, uid: string, secret: string): string {
  const u = normalizeUid(uid);
  return createHmac("sha256", secret).update(`${code}|${u}`).digest("hex").slice(0, 32);
}

export function verifyToken(code: string, uid: string, token: string, secret: string): boolean {
  const expected = signToken(code, uid, secret);
  const got = (token || "").trim().toLowerCase();
  if (expected.length !== got.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

export function parseNdef(text: string): { code: string; token: string } | null {
  const p = (text || "").trim().split("|");
  return p.length === 3 && p[0] === "AL1" ? { code: p[1], token: p[2] } : null;
}
```

### 4.6 Wichtige Feinheit bei `valid: true`

Der Generator liefert `valid: true` **auch dann**, wenn die Signatur stimmt, der
Tag aber noch **nie committed** wurde (`bound_uid == null`). Grund: die Signatur
allein beweist Echtheit, aber nicht Registrierung. Für starken Kopierschutz sollte
dieses Projekt **`bound_uid` prüfen**: ist es `null`, gilt der Tag als „echt, aber
noch nicht aktiviert/registriert" — je nach Use-Case ablehnen oder als Sonderfall
behandeln.

---

## 5. Airlock-API-Referenz

Alle Endpoints erfordern einen API-Key (`X-API-Key` oder `Authorization: Bearer`).

**Diese Endpoints nutzt der KG-Tracker** (mit dem eingeschränkten
`AIRLOCK_KG_API_KEY`, serverseitig):

| Endpoint | Zweck | Antwort |
|---|---|---|
| `GET /v1/airlocks?available=true` | verfügbare Locks (gedruckt, getaggt, frei) | `[AirlockOut]` |
| `GET /v1/airlocks/{code}` | ein Lock inkl. `status`, `nfc_uid` | `AirlockOut` \| 404 |
| `PATCH /v1/airlocks/{code}` `{status}` | Statuswechsel (`active`/`retired`/…) | `AirlockOut` \| 404 \| 422 |
| `POST /v1/airlocks/{code}/nfc/verify` `{uid,token[,require_status]}` | Echtheit + UID-Bindung + Status prüfen | `{valid,reason,status,bound_uid}` |

`AirlockOut` enthält u. a.: `code, status, source, batch_id, stl_url, stl_sha256,
created_at, nfc_uid, nfc_written_at`.

**Diese Endpoints gehören dem Betreiber** (voller `AIRLOCK_API_KEY`) und sind für
den KG-Tracker **gesperrt**: `POST /v1/airlocks:generate`,
`GET /v1/airlocks/{code}/stl`, `POST /v1/airlocks:threemf`,
`POST …/nfc/prepare`, `POST …/nfc/commit`, `GET /v1/config`, `POST /v1/update/*`.

> `?available=true`, `require_status` und der getrennte `AIRLOCK_KG_API_KEY`
> kommen mit **Airlock v1.6.0**. Bis dahin geht `verify` mit dem vollen Key, und
> „verfügbar" wird clientseitig aus `GET /v1/airlocks` gefiltert.

---

## 6. iOS/Android-Umsetzung (Entscheidung aus der Recherche)

Kernentscheidung: **kein kostenpflichtiges Plugin nötig** — ein **eigenes,
kleines Capacitor-Plugin** (oder ein nativer Core-NFC-Anteil) ist der sauberste,
kostenlose Weg und liefert genau **UID + NDEF**.

- **iOS (Core NFC):** `NFCTagReaderSession` mit Format `.iso14443` liefert für
  NTAG (MIFARE Ultralight) sowohl die **Hardware-UID** (tag identifier) als auch
  den **NDEF-Inhalt**. Voraussetzungen:
  - Capability **„Near Field Communication Tag Reading"** aktivieren.
  - Entitlement `com.apple.developer.nfc.readersession.formats` = `["NDEF","TAG"]`
    (`TAG` ist der, der die UID liefert!).
  - `NFCReaderUsageDescription` in `Info.plist`.
  - NFC-Capability für die App-ID im Apple-Developer-Portal aktivieren.
  - **Kostenpflichtiger Apple-Developer-Account** (~99 $/Jahr) nötig; nur auf
    **echtem iPhone 7+** (kein Simulator); UID-Lesen ab **iOS 13+**.
- **Android:** dasselbe Custom-Plugin greift nativ; alternativ **Web NFC**
  (`NDEFReader`, `serialNumber` = UID) in Chrome über HTTPS.
- **Web/Desktop (Safari/iOS-Browser):** **kein** Web NFC → nur über den nativen
  Anteil.
- **UID-Normalisierung:** immer `canonicalUid()` (Abschnitt 3) anwenden, damit
  iOS- und Android-gelesene UIDs zum beim Schreiben verwendeten Wert passen.

> Kostenhinweis: Wird ohnehin eine native App gebaut (Apple-Account läuft), kostet
> ein selbstgeschriebenes NFC-Plugin **0 € extra** — Kaufplugins (z. B. Capawesome
> ~29 $/Monat) sind damit unnötig.

---

## 7. Integration in dieses Projekt (bereits Capacitor)

Dieses Projekt (chastitytracker-Fork) ist **keine reine Web-App und muss nicht
portiert werden** — es ist eine **Next.js-PWA, bereits mit Capacitor 8 als native
iOS-App umhüllt**. Vorhanden sind u. a. `capacitor.config.ts`, das komplette
`ios/`-Projekt, `www/`, `CAPACITOR_PLAN.md` und ein laufender **TestFlight**-
Prozess (`TESTFLIGHT.md`). Es gibt aktuell **kein** NFC-Plugin in den Dependencies.

**Shell-Modell (wichtig fürs Plugin):** `www/index.html` liest die Instanz-URL und
navigiert den WKWebView auf die Live-Instanz; die Capacitor-Bridge bleibt über die
`server.allowNavigation`-Whitelist aktiv. Dadurch sind Capacitor-Plugins **aus der
remote geladenen Web-App heraus aufrufbar** — genauso funktionieren dort schon die
Push-Notifications. Das NFC-Plugin klinkt sich identisch ein.

Was konkret dazukommt (klein, kein Umbau):

- **Nativ (iOS):** eine Swift-Datei in `ios/App/App/` (Core NFC → `{uid, ndefText}`),
  Entitlement `com.apple.developer.nfc.readersession.formats = ["NDEF","TAG"]` in
  `ios/App/App/App.entitlements`, `NFCReaderUsageDescription` in
  `ios/App/App/Info.plist`.
- **Web (Next.js):** `registerPlugin('Nfc')`-Wrapper (TS) + der Verify-Flow aus
  Abschnitt 4. Der Wrapper gehört in den Next.js-Code (nicht in `www/`), weil die
  eigentliche UI remote geladen wird.
- **Android:** dieselbe Plugin-Definition greift nativ; alternativ Web NFC.

Relevante bestehende Dateien: `ios/App/App/App.entitlements`,
`ios/App/App/Info.plist`, `ios/App/App/AppDelegate.swift`, `capacitor.config.ts`,
`www/index.html`. Build/Release nach `TESTFLIGHT.md` (`npx cap sync ios` →
Xcode „Archive → Distribute"). **Hinweis:** iOS-Builds brauchen Xcode auf einem
Mac — in einer reinen Cloud-Session nicht kompilierbar.

**Apple-Account / Signing:** Das aktuelle Signing-Team im Repo ist „Jonas Fahrni"
(Team `C4RN29TT3H`, Bundle `ch.chastitytracker.app`) — der Upstream. Mit einem
**eigenen** Apple-Developer-Account nutzt du deine **eigene Team-ID**, aktivierst
die **NFC-Capability auf deiner eigenen App-ID** und brauchst i. d. R. eine
**eigene Bundle-ID** (das bestehende `ch.chastitytracker.app` gehört dem
Upstream-Team). APNs-Key und TestFlight laufen dann ebenfalls über deinen Account.

---

## 8. Konfiguration / Secrets

Für **Weg A** braucht dieses Projekt (alles **nur im KG-Tracker-Backend**):

- `AIRLOCK_KG_API_KEY` — der eingeschränkte KG-Tracker-Key der Airlock-Instanz
  (Lesen + Statuswechsel + `verify`). Nie ins Frontend (siehe 4.5). Bis v1.6.0
  ersatzweise der volle `AIRLOCK_API_KEY`.
- `generator_base` — Basis-URL der erreichbaren Airlock-Instanz (HTTPS).

`AIRLOCK_NFC_SECRET` wird hier **nicht** benötigt — die HMAC-Prüfung passiert im
Airlock-Generator. (Nur relevant, falls doch mal Weg B genutzt würde.)

---

## 9. Offene Punkte für den Implementierer

- [x] **Entschieden: Weg A** (Airlock-App online + macht die Validierung;
      KG-Tracker = Frontend, generiert nichts). Weg B entfällt.
- [ ] **Backend-Proxy** im KG-Tracker: hält `AIRLOCK_KG_API_KEY` + `generator_base`
      serverseitig und kapselt alle Airlock-Aufrufe (nie aus dem Frontend).
- [ ] **Verfügbare Locks** anzeigen (`GET /v1/airlocks?available=true`; bis v1.6.0
      clientseitig filtern) → Auswahl-UI für die Keyholderin.
- [ ] **Auswählen & aktivieren**: `PATCH /v1/airlocks/{code}` `{status:"active"}`;
      Zuordnung Lock ↔ Nutzer:in/Session **im KG-Tracker** speichern.
- [ ] **Prüf-Anforderung**: Tag lesen → `parseNdef` → `verify`-Aufruf → Ergebnis;
      `status == "active"` erzwingen (bzw. `require_status` ab v1.6.0).
- [ ] Airlock-Instanz per HTTPS erreichbar machen; klarer Fehlerzustand für
      „Airlock nicht erreichbar".
- [ ] Custom-Capacitor-NFC-Plugin schreiben (Swift Core NFC → `{uid, ndefText}`
      an JS) + TS-Wrapper (`registerPlugin('Nfc')`).
- [ ] `canonicalUid()` einmal gegen einen echten, vom Generator beschriebenen Tag
      testen (Byte-Reihenfolge Android↔iOS).
- [ ] `bound_uid == null`-Fall behandeln (echt-aber-nicht-registriert).
- [ ] Entitlements/Info.plist/Portal-Capability für NFC setzen; eigener
      Apple-Account + eigene Bundle-ID (siehe Abschnitt 7).

---

*Referenzquellen im Generator-Repo: `app/nfc.py` (Algorithmus), `app/main.py`
(Endpoints), `docs/NFC.md` (Spezifikation), `app/config.py` (`AIRLOCK_NFC_SECRET`).*
