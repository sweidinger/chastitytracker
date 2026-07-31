#!/usr/bin/env bash
# Airlock-NFC + Push — bringt die nativen iOS-Anteile in das (gitignorte, per `cap add/sync`
# generierte) iOS-Projekt zurück. Idempotent — beliebig oft ausführbar. NACH `npx cap add ios`
# bzw. `npx cap sync ios` laufen lassen. Siehe docs/AIRLOCK_NFC_IOS.md und TESTFLIGHT.md.
#
# WICHTIG: `npx cap add ios` erzeugt ein FRISCHES AppDelegate.swift + App.entitlements ohne die
# Push-Weiterleitung und ohne aps-environment. Ohne diese Schritte läuft die Push-Registrierung
# in den Timeout ("Push-Registrierung fehlgeschlagen … (timeout)"). Dieses Skript stellt sie wieder her.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
IOS_APP="$REPO/ios/App/App"
SRC="$REPO/ios-native"

if [ ! -d "$IOS_APP" ]; then
  echo "❌ $IOS_APP fehlt — zuerst 'npx cap add ios' (und 'npx cap sync ios') ausführen."
  exit 1
fi

# 1) Swift-NFC-Plugin ins iOS-Projekt kopieren.
cp "$SRC/Nfc.swift" "$IOS_APP/Nfc.swift"
echo "✓ Nfc.swift → ios/App/App/"

# 2) Entitlements: den NFC-Formats-Key idempotent setzen. NUR `TAG` — wir nutzen NFCTagReaderSession
#    und lesen NDEF über das Tag-Protokoll. Das Format `NDEF` (für NFCNDEFReaderSession) NICHT setzen:
#    App-Store-Upload lehnt es sonst ab ("NDEF is disallowed", Fehler 90778). Eine bestehende
#    App.entitlements (z.B. mit aps-environment für Push) bleibt erhalten — nur der NFC-Key wird ersetzt.
ENT="$IOS_APP/App.entitlements"
if [ ! -f "$ENT" ]; then
  cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
PLIST
  echo "  (App.entitlements neu angelegt)"
fi
/usr/libexec/PlistBuddy -c "Delete :com.apple.developer.nfc.readersession.formats" "$ENT" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :com.apple.developer.nfc.readersession.formats array" "$ENT"
/usr/libexec/PlistBuddy -c "Add :com.apple.developer.nfc.readersession.formats:0 string TAG" "$ENT"
echo "✓ NFC-Entitlement (TAG) gesetzt in App.entitlements"

# 3) Info.plist: NFCReaderUsageDescription + Export-Compliance (kein NFC-Bezug, aber praktisch fürs
#    TestFlight/fastlane-Upload: erspart die Verschlüsselungs-Rückfrage). Idempotent.
PLIST_FILE="$IOS_APP/Info.plist"
DESC="Zum Prüfen der Echtheit deines Airlock-Schlosses per NFC-Tag."
/usr/libexec/PlistBuddy -c "Set :NFCReaderUsageDescription $DESC" "$PLIST_FILE" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NFCReaderUsageDescription string $DESC" "$PLIST_FILE"
echo "✓ NFCReaderUsageDescription gesetzt in Info.plist"
/usr/libexec/PlistBuddy -c "Set :ITSAppUsesNonExemptEncryption false" "$PLIST_FILE" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$PLIST_FILE"
echo "✓ ITSAppUsesNonExemptEncryption=false gesetzt in Info.plist"

# 4) AppDelegate: APNs-Weiterleitung an Capacitor wiederherstellen. Ein frisch per `cap add ios`
#    erzeugtes AppDelegate.swift enthält die zwei Push-Methoden NICHT → Push-Registrierung feuert
#    weder `registration` noch `registrationError` → 15s-Timeout in src/lib/nativePush.ts. Wir
#    kopieren die gepflegte Referenz aus ios-native/. (Falls du eigene AppDelegate-Logik ergänzt,
#    diese Referenz mitpflegen.)
if [ -f "$SRC/AppDelegate.swift" ]; then
  cp "$SRC/AppDelegate.swift" "$IOS_APP/AppDelegate.swift"
  echo "✓ AppDelegate.swift (inkl. APNs-Weiterleitung) → ios/App/App/"
else
  echo "⚠︎ ios-native/AppDelegate.swift fehlt — AppDelegate NICHT angefasst (Push bleibt kaputt!)"
fi

# 5) Entitlements: aps-environment (Push) NUR ergänzen, wenn es fehlt — einen von Xcode/der
#    "Push Notifications"-Capability bereits gesetzten Wert (dev/prod, automatisch verwaltet) NICHT
#    überschreiben. Nur beim komplett neu erzeugten Projekt ist der Key weg → dann Default `production`
#    (TestFlight/App-Store-Archive; per APS_ENV=development übersteuerbar für lokale Dev-Builds).
if /usr/libexec/PlistBuddy -c "Print :aps-environment" "$ENT" >/dev/null 2>&1; then
  echo "✓ aps-environment bereits gesetzt ($(/usr/libexec/PlistBuddy -c 'Print :aps-environment' "$ENT")) — unverändert"
else
  /usr/libexec/PlistBuddy -c "Add :aps-environment string ${APS_ENV:-production}" "$ENT"
  echo "✓ aps-environment=${APS_ENV:-production} in App.entitlements ergänzt (fehlte)"
fi

echo ""
echo "Noch EINMALIG in Xcode (überlebt danach 'cap sync'):"
echo "  1. Nfc.swift ist im App-Ordner — sicherstellen, dass es Mitglied des App-Targets ist"
echo "     (Xcode: Datei auswählen → File Inspector → Target Membership: App ✓)."
echo "  2. Target 'App' → Signing & Capabilities → '+ Capability' → 'Near Field Communication Tag Reading'"
echo "     → bei den Formaten NUR 'TAG' anhaken (NDEF NICHT — App-Store-Upload lehnt es sonst ab)."
echo "  3. Target 'App' → Signing & Capabilities → '+ Capability' → 'Push Notifications'."
echo "     (Aktiviert Push auf deiner App-ID; bei automatischem Signing regelt Xcode dev/prod selbst.)"
echo "  4. Build Settings → 'Code Signing Entitlements' zeigt auf App/App.entitlements."
