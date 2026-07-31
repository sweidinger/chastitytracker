# Airlock-NFC — iOS-Build & natives NFC-Plugin

Diese Datei beschreibt, wie der native NFC-Anteil des Airlock-Features in die bestehende
Capacitor-iOS-App kommt und wie ein signierter TestFlight-Build entsteht. Der Web-/Server-Teil
(Phasen 1–3) ist bereits im Repo; hier geht es nur um das native Plugin + den Build.

> Voraussetzung: **eigener** Apple-Developer-Account, **eigene** Bundle-ID und die **NFC-Tag-Reading-
> Capability** auf deiner App-ID. Das aktuelle Signing im Repo (Team `C4RN29TT3H`, Bundle
> `ch.chastitytracker.app`) gehört dem Upstream „Jonas Fahrni" und wird ersetzt.

## Was im Repo liegt (getrackt)

- `ios-native/Nfc.swift` — das Capacitor-Plugin (Core NFC → `{ uid, ndefText }`).
- `ios-native/App.entitlements` — Referenz für den NFC-Entitlement-Key.
- `scripts/apply-ios-nfc.sh` — kopiert/patcht die nativen Teile ins generierte `ios/` (idempotent).
- `src/lib/nfc.ts` — TS-Wrapper (`isNfcAvailable`, `scanNfcTag`), dynamischer Capacitor-Import.

`/ios/` selbst ist **gitignored** — das Xcode-Projekt wird lokal per `cap add`/`cap sync` erzeugt.

## Einmalige Toolchain (Mac)

```bash
xcode-select --install            # falls nur CLT vorhanden: hier zusätzlich das volle Xcode aus dem App Store
sudo gem install cocoapods        # oder: brew install cocoapods
brew install fastlane             # optional, für die automatisierte Signing-/TestFlight-Pipeline
```

## iOS-Projekt erzeugen + NFC einbauen

```bash
npm ci
npm run build                     # Next-Build (falls der Shell-/www-Teil neu gebaut werden muss)
npx cap add ios                   # erzeugt ios/ (nur beim ersten Mal)
npx cap sync ios                  # kopiert Web-Assets + Pods
bash scripts/apply-ios-nfc.sh     # Nfc.swift + Entitlement + Info.plist-Key setzen
```

Danach **einmalig in Xcode** (`ios/App/App.xcworkspace` öffnen):

1. **Signing:** Target `App` → *Signing & Capabilities* → dein **Team** wählen, **eigene Bundle-ID**
   setzen (z. B. `de.deinname.chastitytracker`).
2. **NFC-Capability:** *+ Capability* → **Near Field Communication Tag Reading**.
3. **Nfc.swift** prüfen: File-Inspector → *Target Membership* → `App` ✓ (damit es kompiliert wird).
4. **Entitlements:** *Build Settings* → *Code Signing Entitlements* → `App/App.entitlements`.

`cap sync` (nicht `cap add`) überschreibt diese Einstellungen danach nicht mehr — der
`apply-ios-nfc.sh`-Lauf reicht bei jedem weiteren Sync für Swift/Info.plist/Entitlements.

## Signieren & TestFlight (zwei Wege)

**A) Manuell in Xcode:** *Product → Archive* → *Distribute App* → *TestFlight*.

**B) Automatisiert per fastlane** (nach einmaligem App-Store-Connect-API-Key):
Portal → *Users and Access → Integrations → App Store Connect API* → Key erzeugen, `.p8` laden,
*Issuer ID* + *Key ID* notieren. Dann grob:

```bash
export ASC_KEY_ID=...           ASC_ISSUER_ID=...        ASC_KEY_PATH=/pfad/AuthKey_XXXX.p8
fastlane produce -u <appleid> -a de.deinname.chastitytracker --skip_itc   # App-ID anlegen
# NFC-Capability + Provisioning: in fastlane via sigh/match bzw. produce enable_services
fastlane gym --workspace ios/App/App.xcworkspace --scheme App             # Build/Archive
fastlane pilot upload --api_key_path fastlane_asc_key.json                # TestFlight-Upload
```

(Die genaue Fastfile schreiben wir, sobald der API-Key da ist — dann läuft der Build/Upload
weitgehend nicht-interaktiv, auch aus der Cowork-Session per „Control your Mac".)

## On-Device-Test (iPhone 11 Pro)

1. App per Xcode aufs iPhone (mit deinem Team signiert) oder via TestFlight installieren.
2. In der App den Verschluss-/Kontroll-Flow öffnen → **NFC scannen** → iPhone an ein vom
   Airlock-Generator beschriebenes Schloss halten.
3. **Byte-Reihenfolge einmalig verifizieren** (docs/AIRLOCK_NFC.md §3): die gelesene, kanonisierte
   UID muss der beim Schreiben gebundenen entsprechen. Beginnt sie nicht mit `04`, greift
   `canonicalUid()` und dreht — beim ersten echten Tag gegenprüfen, dass Schreib- und Leseseite
   dieselbe kanonische UID erzeugen (sonst schlägt die Airlock-`verify` trotz echtem Tag fehl).

## Registrierung des Plugins

`Nfc.swift` implementiert `CAPBridgedPlugin` (Capacitor 8) und wird als app-lokales Plugin automatisch
geladen; JS-Seitig genügt `registerPlugin('Nfc')` (im Wrapper `src/lib/nfc.ts` gekapselt). Sollte der
Aufruf auf dem Gerät `Nfc` nicht finden, als Fallback eine `NfcPlugin.m` mit dem `CAP_PLUGIN`-Makro
ergänzen (klassische ObjC-Registrierung) — dann ist die Registrierung garantiert.
