# Cron-Jobs (optional): autonomer KI-Keyholder & automatisches Belohnungs-Guthaben

Das Produktions-`docker-compose.yml` ist bewusst schlank und enthält **keinen** Cron.
Drei Hintergrund-Jobs sind optional, aber empfohlen, wenn die betreffenden Features genutzt werden.
Alle drei rufen einen HTTP-Endpunkt der App per `POST` mit einem geteilten Bearer-Secret auf.

| Job | Endpunkt | Intervall | Wozu |
|---|---|---|---|
| Media-Poll | `/api/ai-keyholder/media-poll` | alle 3 min | Generierte KI-Medien nachziehen |
| Autonomer Lauf | `/api/ai-keyholder/run` | jede Minute | Autonome KI-Keyholderin (entscheidet selbst pro Nutzer anhand `nextRunAt`) |
| Belohnungs-Reconcile | `/api/rewards/reconcile` | alle 5 min | Erreichte Trainingsziele als Guthaben gutschreiben |

## Warum der Reconcile-Job?

Zielerreichung ist **zeitkontinuierlich** (die Tragezeit läuft gegen die aktuelle Uhrzeit) und
erzeugt kein Datenbank-Ereignis, auf das man reagieren könnte. Das Guthaben wird deshalb an drei
Stellen nachgezogen: beim Öffnen/Session-Ende (Eintrag), beim Keyholder-Statusabruf (Overview) und
periodisch durch **diesen Cron** — das Sicherheitsnetz für Nutzer mit Admin-Keyholder (ohne KI) und
für Ziele, die während einer laufenden Session erreicht werden. Ohne den Cron greifen die beiden
anderen Auslöser weiterhin; nur die zeitnahe Gutschrift „während getragen" fehlt dann.

## Voraussetzung

In der `.env` (bzw. den Container-Umgebungsvariablen) muss ein geteiltes Secret gesetzt sein:

```
AI_KEYHOLDER_CRON_SECRET=<langes-zufaelliges-secret>
```

Die drei Endpunkte akzeptieren dieses Secret als `Authorization: Bearer <secret>` (der Reconcile-
Endpunkt zusätzlich eine Admin-Session). `proxy.ts` nimmt diese vier Routen bewusst vom
Session-Gate aus, prüft aber den Token im Handler.

## docker-compose-Snippet

Als zusätzlichen Service neben `kg-tracker` einhängen (Service-/Hostname `kg-tracker` an die eigene
Instanz anpassen; hier heisst der App-Container `kg-tracker`):

```yaml
  cron:
    image: alpine:3.21
    restart: unless-stopped
    depends_on:
      - kg-tracker
    env_file:
      - .env
    command: >
      sh -c "
        apk add --no-cache curl -q 2>/dev/null;
        H=\"http://kg-tracker:3000\";
        A=\"-H 'Authorization: Bearer $$AI_KEYHOLDER_CRON_SECRET' -H 'Content-Type: application/json'\";
        echo '#!/bin/sh' > /p.sh;  echo \"curl -sf -X POST $$H/api/ai-keyholder/media-poll $$A --max-time 30\" >> /p.sh;
        echo '#!/bin/sh' > /r.sh;  echo \"curl -sf -X POST $$H/api/ai-keyholder/run $$A --max-time 30\" >> /r.sh;
        echo '#!/bin/sh' > /rc.sh; echo \"curl -sf -X POST $$H/api/rewards/reconcile $$A --max-time 60\" >> /rc.sh;
        chmod +x /p.sh /r.sh /rc.sh;
        echo '*/3 * * * * /p.sh >> /tmp/poll.log 2>&1'      > /etc/crontabs/root;
        echo '*   * * * * /r.sh >> /tmp/run.log 2>&1'      >> /etc/crontabs/root;
        echo '*/5 * * * * /rc.sh >> /tmp/reconcile.log 2>&1' >> /etc/crontabs/root;
        crond -f -l 6
      "
```

Nur den Reconcile-Job (ohne KI-Keyholder) benötigt eine Instanz, die die KI-Features nicht nutzt —
dann nur `/rc.sh` + dessen crontab-Zeile behalten.

## Verifikation

```bash
# Läuft der Job? (Antwort z.B. {"checkedUsers":N,"usersWithCredit":..,"totalCredited":..})
docker exec <cron-container> sh /rc.sh
# 401 => Secret stimmt nicht oder proxy.ts nimmt die Route nicht aus.
```
