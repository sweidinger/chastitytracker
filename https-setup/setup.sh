#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# HTTPS-Setup: Nginx Reverse Proxy mit Self-Signed CA für ChastityTracker Beta
# Ausführen auf dem NAS: bash setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

DOMAIN="10.0.1.9"          # lokale IP des NAS
HTTPS_PORT="3443"           # HTTPS-Port (443 ggf. belegt durch NAS-WebUI)
APP_PORT="3003"             # interner App-Port (kein Änderungsbedarf)
CERT_DIR="/volume1/docker/chastitytracker-beta/certs"
NGINX_DIR="/volume1/docker/chastitytracker-beta/nginx"
ENV_FILE="/volume1/docker/chastitytracker-beta/.env"

echo "==> Verzeichnisse anlegen …"
mkdir -p "$CERT_DIR" "$NGINX_DIR"

# ── 1. CA-Schlüssel + CA-Zertifikat ──────────────────────────────────────────
echo "==> CA-Schlüssel generieren …"
openssl genrsa -out "$CERT_DIR/ca.key" 4096

echo "==> CA-Zertifikat generieren (5 Jahre) …"
openssl req -x509 -new -nodes \
  -key "$CERT_DIR/ca.key" \
  -sha256 -days 1825 \
  -out "$CERT_DIR/ca.crt" \
  -subj "/C=CH/ST=Local/L=Local/O=ChastityTracker CA/CN=ChastityTracker Local CA"

# ── 2. Server-Schlüssel + CSR + Zertifikat ───────────────────────────────────
echo "==> Server-Schlüssel generieren …"
openssl genrsa -out "$CERT_DIR/server.key" 2048

echo "==> CSR mit SAN (IP + localhost) erstellen …"
openssl req -new \
  -key "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.csr" \
  -subj "/C=CH/ST=Local/L=Local/O=ChastityTracker/CN=$DOMAIN"

# SAN-Extension (Subject Alternative Names) — iPhone braucht zwingend IP-SAN
cat > "$CERT_DIR/san.ext" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
IP.1 = $DOMAIN
IP.2 = 127.0.0.1
DNS.1 = localhost
EOF

echo "==> Server-Zertifikat signieren (2 Jahre) …"
openssl x509 -req \
  -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/server.crt" \
  -days 730 \
  -sha256 \
  -extfile "$CERT_DIR/san.ext"

# ── 3. CA-Zertifikat ins App-Verzeichnis kopieren (für iPhone-Download) ──────
cp "$CERT_DIR/ca.crt" /volume1/docker/chastitytracker-beta/ca.crt
echo "==> CA-Zertifikat gespeichert unter: /volume1/docker/chastitytracker-beta/ca.crt"

# ── 4. Nginx-Konfiguration schreiben ─────────────────────────────────────────
echo "==> Nginx-Konfiguration schreiben …"
cat > "$NGINX_DIR/default.conf" <<EOF
server {
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/nginx/certs/server.crt;
    ssl_certificate_key /etc/nginx/certs/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Für SSE (Streaming-Chat der KI-Keyholderin)
    proxy_buffering     off;
    proxy_read_timeout  300s;
    proxy_send_timeout  300s;

    # CA-Zertifikat zum Download bereitstellen
    location = /ca.crt {
        alias /etc/nginx/certs/ca.crt;
        add_header Content-Type application/x-x509-ca-cert;
        add_header Content-Disposition 'attachment; filename="ChastityTracker-CA.crt"';
    }

    location / {
        proxy_pass         http://host.docker.internal:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_cache_bypass \$http_upgrade;
    }
}

# HTTP → HTTPS redirect
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host:$HTTPS_PORT\$request_uri;
}
EOF

# ── 5. Nginx Docker-Container starten ────────────────────────────────────────
echo "==> Alten Nginx-Container entfernen (falls vorhanden) …"
docker rm -f chastitytracker-nginx 2>/dev/null || true

echo "==> Nginx-Container starten …"
docker run -d \
  --name chastitytracker-nginx \
  --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  -p "$HTTPS_PORT:443" \
  -p "8080:80" \
  -v "$CERT_DIR:/etc/nginx/certs:ro" \
  -v "$NGINX_DIR/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine

# ── 6. .env aktualisieren ────────────────────────────────────────────────────
echo "==> .env-Datei auf HTTPS aktualisieren …"

# Backup
cp "$ENV_FILE" "${ENV_FILE}.bak"

# NEXTAUTH_URL
sed -i "s|^NEXTAUTH_URL=.*|NEXTAUTH_URL=https://$DOMAIN:$HTTPS_PORT|" "$ENV_FILE"

# WEBAUTHN
sed -i "s|^WEBAUTHN_RP_ID=.*|WEBAUTHN_RP_ID=$DOMAIN|" "$ENV_FILE"
sed -i "s|^WEBAUTHN_RP_ORIGIN=.*|WEBAUTHN_RP_ORIGIN=https://$DOMAIN:$HTTPS_PORT|" "$ENV_FILE"

echo ""
echo "════════════════════════════════════════════════════════"
echo "✅  HTTPS-Setup abgeschlossen!"
echo ""
echo "App erreichbar unter: https://$DOMAIN:$HTTPS_PORT"
echo ""
echo "📱 iPhone-Einrichtung:"
echo "   1. Im Safari öffnen: https://$DOMAIN:$HTTPS_PORT/ca.crt"
echo "      → 'Profil laden' bestätigen"
echo "   2. Einstellungen → Allgemein → VPN & Geräteverwaltung"
echo "      → Profil 'ChastityTracker Local CA' installieren"
echo "   3. Einstellungen → Allgemein → Info"
echo "      → Zertifikatsvertrauenseinstellungen"
echo "      → 'ChastityTracker Local CA' aktivieren"
echo "   4. Safari öffnen: https://$DOMAIN:$HTTPS_PORT"
echo "      → 'Zum Home-Bildschirm' hinzufügen"
echo "   5. App vom Home-Bildschirm öffnen → Push erlauben"
echo "════════════════════════════════════════════════════════"

echo ""
echo "⚠️  App muss neu gestartet werden damit .env-Änderungen wirken:"
echo "   docker restart chastitytracker-beta"
