# Multi-Device Development Setup - Implementation Report

## Ergebnis

KeyCore besitzt eine plattformübergreifende, PowerShell-taugliche
Entwicklungsoberfläche für unabhängige lokale Umgebungen auf PC 1 und PC 2.
Sie verwendet die bestehende Full-Stack-Compose-Datei, die vorhandenen
Migrationen, Seeds und WordPress-Bootstrap-Dienste. Es wurde keine zweite
Runtime-Architektur und keine Datenbankmigration eingeführt.

## Branch-Basis

Die Implementierung wurde von `feature/admin-panel-v1-1-polish` bei
`acf687ecfbcf74c3732cdc76a2e826939f0c6142` abgezweigt. Diese Basis enthält die
für eine reale Validierung erforderliche aktuelle Admin-/Storefront-
Architektur, Migration 036 und die Human-akzeptierten Kategorien 05 und 06.
Der Multi-Device-Branch und sein eigener PR bleiben von PR #62 getrennt.

## Implementierung

- `dev:setup`, `dev:start`, `dev:status`, `dev:logs`, `dev:check`, `dev:stop`,
  `dev:handoff` und `dev:prerequisites` bilden die Human-Schnittstelle.
- Das Tooling verlangt Node `22.22.0`, npm Major 11, Git, Docker und Compose v2,
  installiert aber keine Systemsoftware.
- Eine fehlende `infra/docker/staging.local.env` wird atomar aus der getrackten
  Vorlage mit kryptografischer Zufälligkeit erzeugt. Vorhandene Dateien werden
  nie überschrieben; Werte werden nicht ausgegeben.
- Fresh Setup erkennt den vollständigen Volume-Satz, verwendet `npm ci`, die
  bestehenden Migration-/Seed-Pfade sowie das vorhandene
  `wordpress-bootstrap`-Profil. Bestehende vollständige Volumes werden nicht
  reseeded; Teilzustände brechen sicher ab.
- Normaler Stop ist ausschließlich Compose `down` ohne `--volumes`.
- Logs sind auf 200 Zeilen begrenzt. Status liest Compose-Health, HTTP-Endpunkte,
  Git-Branch und HEAD ohne Mutation.
- Git-Handoff meldet Working Tree, Upstream und Ahead/Behind, führt aber weder
  Fetch, Pull, Commit, Stash, Reset noch Push aus.
- PHP-/WordPress-Prüfungen nutzen einen plattformneutralen PHP-Linter und auf
  Windows das Composer-Docker-Image.
- Der Secret-Scan liest nur getrackte und nicht ignorierte ungetrackte Dateien.
  Bekannte ignorierte lokale Geheimdateien werden dadurch nicht geöffnet.

## Daten- und Sicherheitsgrenzen

Die PC-1-Volumes, Datenbanken und lokalen Konfigurationen werden nicht
zurückgesetzt oder übernommen. Standardmäßig besitzt jeder PC eigene lokale
Daten. Die optionale PostgreSQL-Übertragung ist im Guide als separate,
checksum-geprüfte und ausdrücklich destruktive PC-2-Restore-Operation
dokumentiert. MariaDB, Redis und Secrets werden dabei nicht automatisch
übertragen.
Für eine bewusst restaurierte Review-Datenbank dokumentiert der Guide die
minimalen echten Abhängigkeiten: den festen synthetischen Guest-Claim-Code sowie
Browser-/Fulfillment-Master-Key und Fulfillment-Key-ID. Diese Werte werden
nicht durch Git oder den Dump transportiert und niemals ausgegeben. Das
restaurierte Admin-Passwort wird sicher über den lokalen Mailpit-Reset ersetzt,
statt PC-1-Credentials pauschal zu kopieren.

Alle lokalen Defaults bleiben synthetisch: `STAGING`, Stripe `TEST`, Supplier
`MOCK`, externe Mail deaktiviert und Operations Authority `DISABLED`. Es gibt
keine Produktionserlaubnis und keine Änderung an Human-UAT oder
Security-Readiness.

## Designreferenzen

Die 13 externen Admin-Referenzbilder sind als `EXTERNAL_ONLY` klassifiziert.
Wegen personenbezogener/markenbezogener Inhalte und ungeklärter
Repository-Rechte wurden sie nicht kopiert. Bestehende Implementierungs- und
UAT-Berichte bleiben die portable Autorität; neue visuelle Arbeit benötigt
erneute Human-Bereitstellung oder bereinigte Freigabe.

## Rollback

Die Änderung lässt sich durch Revert der Tooling-/Dokumentationsdateien
zurücknehmen. Da keine Migration und kein automatischer Volume-Reset existiert,
bleiben lokale Daten davon unabhängig. Eine erzeugte lokale Env bleibt ignoriert
und muss bei einem Rollback bewusst lokal verwaltet werden.

## Isolierte Validierung

Die vollständige lokale Validierung lief in einem separaten Compose-Projekt
`keycore-staging-multidevice-validation` mit eigenen Ports und vier eigenen
Volumes. Das bestehende PC-1-Projekt `keycore-staging-local-001` und dessen
Volumes blieben währenddessen unverändert.

- Ein frisches `dev:setup` erzeugte die ignorierte lokale Env, installierte die
  Node-Abhängigkeiten, startete den vollständigen Stack, wendete alle 36
  Migrationen an und führte Staging-Seed sowie WordPress-Bootstrap aus.
- Der zweite identische Setup-Lauf erkannte den vollständigen Volume-Satz,
  ließ die Env-Datei unverändert und übersprang Seed und WordPress-Bootstrap.
- `dev:stop` entfernte Container und Netzwerk, erhielt aber alle vier Volumes.
  `dev:start` stellte den Stack mit denselben Daten wieder her.
- Nach dem Wiederanlauf waren 10 Produkte, ein Lieferant und drei Kampagnen
  vorhanden. Storefront und Admin-Health antworteten jeweils mit HTTP 200.
- `dev:status` änderte weder Container, Volumes noch den vorhandenen Git-Diff;
  `dev:logs -- admin` blieb auf den vorgesehenen Ausschnitt begrenzt.
- Die abschließende Bereinigung entfernte ausschließlich das isolierte
  Compose-Projekt und dessen vier Test-Volumes.

Die Validierung deckte zwei lokale Integrationsgrenzen auf, die im selben
Branch korrigiert und regressionsgetestet wurden: frei konfigurierbare lokale
Ports werden aus der Env abgeleitet, und die Staging-Preflight-Prüfung erlaubt
HTTP nur für Loopback-Hosts. Nichtlokale HTTP-Origins, Pfade, Query-Strings und
Fragmente bleiben abgelehnt.

## Quality Gates

- `npm run check`: Format, ESLint, TypeScript und Secret-Scan bestanden; 68
  Testdateien mit 889 Tests bestanden, 30 Dateien mit 150 dienstgebundenen
  Tests übersprungen.
- Fokussierte Dev-Tool-/Preflight-Regression: 44 Tests bestanden.
- Security Assessment: 36 Tests bestanden; 369 dienstgebundene Tests
  übersprungen.
- E2E Acceptance: 15 Tests bestanden; ein PostgreSQL-gebundener Test
  übersprungen.
- `npm audit`: keine Schwachstellen.
- Compose-Konfiguration, Composer-Validierung, PHP-Syntax für 20 Dateien,
  WordPress-Adaptertests, UAT-Strukturvalidierung und `git diff --check`
  bestanden.

## Offene Human-Evidenz

Automatisierte und isolierte lokale Validierung ersetzt nicht die reale
PC-2-Ersteinrichtung. Der erste Human-Schritt auf PC 2 ist die Installation bzw.
Auswahl von Node `22.22.0`, npm 11, Git und Docker Desktop; danach folgt Tabelle
A in `docs/development/MULTI-DEVICE-DEVELOPMENT.md`.
