import Foundation
import Capacitor
import CoreNFC

/**
 * Airlock-NFC — lokales Capacitor-Plugin (Core NFC). Liest von einem NTAG213/215/216 (MIFARE
 * Ultralight, ISO14443-A) BEIDES: die Hardware-UID (aus der Tag-Identifikation, NICHT aus dem NDEF)
 * und den NDEF-Text-Record `AL1|<code>|<token>`. Beides geht als { uid, ndefText } an JS; die
 * Kanonisierung/Verifikation passiert web-/serverseitig (Weg A, siehe docs/AIRLOCK_NFC.md).
 *
 * Registrierung: Capacitor 6+/8 lädt ein app-lokales Plugin, das `CAPBridgedPlugin` implementiert,
 * automatisch (kein .m-Makro nötig). JS-Seite: `registerPlugin('Nfc')`.
 *
 * Voraussetzungen im iOS-Projekt (per scripts/apply-ios-nfc.sh gesetzt):
 *  - Entitlement `com.apple.developer.nfc.readersession.formats = ["NDEF","TAG"]`
 *  - Info.plist `NFCReaderUsageDescription`
 *  - NFC-Tag-Reading-Capability auf der App-ID (Apple Developer Portal)
 */
@objc(NfcPlugin)
public class NfcPlugin: CAPPlugin, CAPBridgedPlugin, NFCTagReaderSessionDelegate {
    public let identifier = "NfcPlugin"
    public let jsName = "Nfc"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
    ]

    private var session: NFCTagReaderSession?
    private var pendingCall: CAPPluginCall?

    /// Kann dieses Gerät NFC-Tags lesen? (iPhone 7+ / iOS 13+)
    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": NFCTagReaderSession.readingAvailable])
    }

    /// Startet eine Lese-Session. Löst mit { uid, ndefText } auf oder rejected mit einem Code
    /// (NFC_UNAVAILABLE | NFC_CANCELLED | NFC_CONNECT_FAILED | NFC_NOT_NTAG | NFC_NDEF_FAILED | NFC_ERROR).
    @objc func scan(_ call: CAPPluginCall) {
        guard NFCTagReaderSession.readingAvailable else {
            call.reject("NFC ist auf diesem Gerät nicht verfügbar.", "NFC_UNAVAILABLE")
            return
        }
        // Core NFC muss die Session auf dem Main-Thread starten.
        DispatchQueue.main.async {
            self.pendingCall = call
            call.keepAlive = true
            self.session = NFCTagReaderSession(pollingOption: [.iso14443], delegate: self, queue: nil)
            self.session?.alertMessage = call.getString("alertMessage") ?? "Halte dein iPhone an das Airlock-Schloss."
            self.session?.begin()
        }
    }

    // MARK: - NFCTagReaderSessionDelegate

    public func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}

    public func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        // Wird auch bei User-Abbruch oder Timeout gerufen. Nur reagieren, wenn ein Call noch offen ist
        // (bei erfolgreichem scan haben wir vorher schon aufgelöst und pendingCall genullt).
        guard self.pendingCall != nil else { self.session = nil; return }
        if let nfcErr = error as? NFCReaderError,
           nfcErr.code == .readerSessionInvalidationErrorUserCanceled {
            self.finish(rejectCode: "NFC_CANCELLED", message: "NFC-Scan abgebrochen.")
        } else {
            self.finish(rejectCode: "NFC_ERROR", message: error.localizedDescription)
        }
    }

    public func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        if tags.count > 1 {
            session.alertMessage = "Mehrere Tags erkannt — bitte nur einen."
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { session.restartPolling() }
            return
        }
        guard let tag = tags.first else { return }

        session.connect(to: tag) { [weak self] error in
            guard let self = self else { return }
            if let error = error {
                session.invalidate(errorMessage: "Verbindung zum Tag fehlgeschlagen.")
                self.finish(rejectCode: "NFC_CONNECT_FAILED", message: error.localizedDescription)
                return
            }

            let uid = self.extractUid(from: tag)

            // NDEF wird über das NFCNDEFTag-Protokoll gelesen, dem der verbundene Tag entspricht.
            guard let ndefTag = self.ndefTag(from: tag) else {
                session.invalidate(errorMessage: "Kein lesbarer NDEF-Tag.")
                self.finish(rejectCode: "NFC_NOT_NTAG", message: "Tag unterstützt kein NDEF.")
                return
            }

            ndefTag.readNDEF { [weak self] (message, error) in
                guard let self = self else { return }
                if let error = error {
                    session.invalidate(errorMessage: "NDEF konnte nicht gelesen werden.")
                    self.finish(rejectCode: "NFC_NDEF_FAILED", message: error.localizedDescription)
                    return
                }
                let text = self.firstTextRecord(message) ?? ""
                session.alertMessage = "Airlock gelesen ✓"
                session.invalidate()
                self.finish(resolve: ["uid": uid, "ndefText": text])
            }
        }
    }

    // MARK: - Helpers

    /// Hex-UID (Grossbuchstaben, ohne Trenner) aus der Tag-Identifikation — deckt NTAG (miFare) ab.
    private func extractUid(from tag: NFCTag) -> String {
        let bytes: Data
        switch tag {
        case let .miFare(t):   bytes = t.identifier
        case let .iso7816(t):  bytes = t.identifier
        case let .iso15693(t): bytes = t.identifier
        case let .feliCa(t):   bytes = t.currentIDm
        @unknown default:      bytes = Data()
        }
        return bytes.map { String(format: "%02X", $0) }.joined()
    }

    /// Der verbundene Tag als NDEF-Tag (NTAG ⇒ .miFare, das NFCNDEFTag implementiert).
    private func ndefTag(from tag: NFCTag) -> NFCNDEFTag? {
        switch tag {
        case let .miFare(t):   return t
        case let .iso7816(t):  return t
        case let .iso15693(t): return t
        case let .feliCa(t):   return t
        @unknown default:      return nil
        }
    }

    /// Erster Well-Known-Text-Record (Typ "T"): Payload = [status][lang][utf8-text].
    private func firstTextRecord(_ message: NFCNDEFMessage?) -> String? {
        guard let records = message?.records else { return nil }
        for r in records where r.typeNameFormat == .nfcWellKnown {
            guard let type = String(data: r.type, encoding: .utf8), type == "T" else { continue }
            let payload = r.payload
            guard payload.count > 1 else { continue }
            let langLen = Int(payload[0] & 0x3F)
            guard payload.count >= 1 + langLen else { continue }
            let textData = payload.subdata(in: (1 + langLen)..<payload.count)
            return String(data: textData, encoding: .utf8)
        }
        return nil
    }

    private func finish(resolve dict: [String: Any]? = nil, rejectCode: String? = nil, message: String? = nil) {
        DispatchQueue.main.async {
            if let call = self.pendingCall {
                if let dict = dict {
                    call.resolve(dict)
                } else {
                    call.reject(message ?? "NFC-Fehler", rejectCode ?? "NFC_ERROR")
                }
                call.keepAlive = false
            }
            self.pendingCall = nil
            self.session = nil
        }
    }
}
