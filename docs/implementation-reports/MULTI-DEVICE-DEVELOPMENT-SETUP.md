# Multi-Device Development Setup - Implementation Report

## Ergebnis

KeyCore besitzt eine plattformübergreifende, PowerShell-taugliche
Entwicklungsoberfläche für unabhängige lokale Umgebungen auf PC 1, PC 2 und
Laptop.
Sie verwendet die bestehende Full-Stack-Compose-Datei, die vorhandenen
Migrationen, Seeds und WordPress-Bootstrap-Dienste. Es wurde keine zweite
Runtime-Architektur und keine Datenbankmigration eingeführt.

Der aktuelle Human-bestätigte Gerätestand ist asymmetrisch: PC 1 ist Haupt-PC
und primäres Entwicklungsgerät mit der wertvollen Review-Datenbank. Der Laptop
ist vollständig eingerichtet; lokaler Stack, die von PC 1 übertragene
PostgreSQL-Review-Datenbank, Admin-Login und Review-Daten wurden erfolgreich
getestet. Nur PC 2, der Büro-PC in der Matrix Bochum, benötigt noch das
vollständige New-Device-Onboarding.

## Branch-Basis

Die Implementierung wurde von `feature/admin-panel-v1-1-polish` bei
`acf687ecfbcf74c3732cdc76a2e826939f0c6142` abgezweigt. Diese Basis enthält die
für eine reale Validierung erforderliche aktuelle Admin-/Storefront-
Architektur, Migration 036 und die Human-akzeptierten Kategorien 05 und 06.
Der Multi-Device-Branch und sein eigener PR bleiben von PR #62 getrennt.

## Autorisierte begleitende Scope-Erweiterung

Die repository-weite Bereinigung des veralteten Storefront-Namens
`KeyPlanet` zu `KeyRaNo` ist ausdrücklich durch den Human autorisiert und
absichtlich Bestandteil von PR #63. `KeyCore` bleibt der Name für Backend und
Plattform, `KeyRaNo` ist der aktuelle Frontend-/Shop-Name und `KeyPlanet` wird
in aktueller Code-, UI-, Task- und Projektdokumentation nicht weiterverwendet.
Historische Aussagen werden nur so angepasst, dass sie als historisch und
inzwischen abgelöst erkennbar bleiben. Diese Branding-Bereinigung ist eine
transparente begleitende Scope-Erweiterung und keine technische Voraussetzung
des Multi-Device-Toolings.

## Implementierung

- Die sechs Codex-Kurzbefehle `Start-Work-*` und `Finish-Work-*` sind in
  `AGENTS.md` auf die bestehenden `dev:*`-Mechanismen abgebildet. Codex benötigt
  dafür keinen früheren Chatverlauf.
- `.keycore-device.json` bindet jeden Clone lokal an `PC-1`, `PC-2` oder
  `LAPTOP`. Die Datei ist ignoriert, enthält keinen Fingerprint und besitzt
  keinerlei Authentisierungswirkung. Eine fehlende, beschädigte oder
  abweichende Bindung bricht vor Fetch, Setup, npm, Tests und Docker-Aktionen
  fail-closed ab. Die Start-/Finish-Workflows erzeugen oder überschreiben sie
  niemals automatisch; jeder Clone wird vor seinem ersten Work-Start einmalig
  explizit mit `dev:device` gebunden.
- `dev:work-start` schützt lokale Änderungen, prüft das erwartete GitHub-
  Repository, aktualisiert Remote-Referenzen und erlaubt ausschließlich
  Fast-Forward. Danach delegiert es Toolchain, Abhängigkeiten, Compose,
  Migrationen und Status an `dev:setup`.
- `dev:work-finish` führt die vollständigen lokalen Checks und Handoff-
  Diagnose aus. Es commitet und pusht nie. Nur ein sauberer und synchroner
  Branch wird als übergabebereit gemeldet und volume-erhaltend gestoppt.
- `dev:db-export` erzeugt außerhalb des Repositories einen PostgreSQL-Custom-
  Dump samt SHA-256 und Manifest. `dev:db-import` prüft Hash, Manifest,
  Repository und Commit-Kompatibilität, verlangt die exakte destruktive
  Bestätigung, erzeugt ein Sicherheitsbackup, stoppt Writer und verwendet
  `pg_restore --no-owner --no-privileges --exit-on-error`. Bei Fehler wird das
  Sicherheitsbackup automatisch restauriert.
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
zurückgesetzt. Standardmäßig besitzt jedes Gerät eigene lokale
Daten. Die optionale PostgreSQL-Übertragung ist im Guide als separate,
checksum-geprüfte und ausdrücklich destruktive Zielgeräte-Restore-Operation
dokumentiert. MariaDB, Redis und Secrets werden dabei nicht automatisch
übertragen.
Für eine bewusst restaurierte Review-Datenbank dokumentiert der Guide die
minimalen echten Abhängigkeiten: den festen synthetischen Guest-Claim-Code sowie
Fulfillment-Master-Key und Fulfillment-Key-ID, falls persistiertes
Fulfillment-Material lesbar bleiben muss. Der Browser-Master-Key schützt nur
ein bei jedem Prozessstart neu erzeugtes In-Memory-Fixture und bleibt ebenso
wie Admin-Session-, Cursor-, CSRF- und Bridge-Secrets gerätespezifisch. Diese
Werte werden nicht durch Git oder den Dump transportiert und niemals
ausgegeben. Das restaurierte Admin-Passwort wird sicher über den lokalen
Mailpit-Reset oder einen expliziten Einmal-Rotationslauf ersetzt, statt
PC-1-Credentials pauschal zu kopieren.

## Restore-Bootstrap-Härtung

Der reproduzierte PC-1-zu-PC-2-Fehler lag nicht im Dump, Restore oder
Session-Hash-Secret. Der Admin-Bootstrap adressierte bei jedem Start dieselbe
synthetische Admin-ID und überschrieb deren E-Mail mit dem gerätelokalen
Default, während `PASSWORD_ROTATE=false` den restaurierten Scrypt-Hash korrekt
erhielt. Nach dem Start gehörten E-Mail und Passwort daher nicht mehr zusammen.

Normales Bootstrap legt die synthetische Identity jetzt nur an, wenn sie fehlt.
Bestehende Identity-Felder und Credentials bleiben erhalten. Ein fehlendes
Credential wird weiterhin automatisch provisioniert. Die explizite
`KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD_ROTATE=true`-Semantik ändert nur den
Passwort-Hash und niemals die persistierte E-Mail. Wiederholte Starts bleiben
idempotent; vorhandene Review-Identities bleiben unangetastet. Es wurde keine
Migration eingeführt.

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
  Testdateien mit 905 Tests bestanden, 30 Dateien mit 151 dienstgebundenen
  Tests übersprungen.
- Fokussierte Admin-/Checkout-Persistenz: 15 Tests gegen isolierte PostgreSQL-
  Schemas bestanden, einschließlich Restore-Erhalt und expliziter Rotation.
- `npm run dev:check`: Node-/npm-/Docker-Voraussetzungen, vollständiges
  Node-Gate, Composer-Validierung, PHP-Syntax, WordPress-Adaptertests und
  Compose-Konfiguration bestanden.
- Fokussierte Dev-Tool-/Preflight-Regression: 49 Tests bestanden.
- Security Assessment: 36 Tests bestanden; 369 dienstgebundene Tests
  übersprungen.
- E2E Acceptance: 15 Tests bestanden; ein PostgreSQL-gebundener Test
  übersprungen.
- `npm audit`: keine Schwachstellen.
- Compose-Konfiguration, Composer-Validierung, PHP-Syntax für 20 Dateien,
  WordPress-Adaptertests, UAT-Strukturvalidierung und `git diff --check`
  bestanden.

## Offene Human-Evidenz

Der Laptop-Praxistest ist abgeschlossen: Entwicklungssystem, Stack,
PostgreSQL-Review-Daten, Admin-Login und Review-Daten funktionieren. Auf PC 1
meldeten `Start-Work-PC-1` und `Finish-Work-PC-1` nacheinander
`ARBEITSBEREIT` und `ÜBERGABEBEREIT`.

Beim ersten Laptop-Start stand der Clone noch auf `5efed8f`. Der damals aktive
Ablauf synchronisierte zunächst den Repository-Stand und zog dabei
`68a92d9abe1c89a4facc925f0090975c5aaaad10` ein. Erst dieser Commit enthielt die
neuen Device-/Work-Start-/Work-Finish-Mechanismen. Der historische Start konnte
daher noch ohne `.keycore-device.json` arbeitsbereit werden. Beim
anschließenden Finish war der neue Code bereits aktiv und erkannte die fehlende
Bindung korrekt fail-closed. Nach der einmaligen expliziten Bindung als
`LAPTOP` meldete `Finish-Work-Laptop` `ÜBERGABEBEREIT`: Working Tree sauber,
Ahead/Behind 0/0, 900 Tests bestanden, 151 übersprungen, Format, Lint,
Typprüfung und Secret-Scan bestanden sowie der Stack volume-erhaltend gestoppt.
Dies war keine Start-/Finish-Asymmetrie des aktuellen Codes, sondern eine
einmalige Versionsgrenze während des ersten Laptop-Wechsels.

Offene Human-Evidenz betrifft nur die reale PC-2-Ersteinrichtung. Der erste
Human-Schritt auf PC 2 ist die Installation bzw. Auswahl von Node `22.22.0`,
npm 11, Git und Docker Desktop; danach folgt Tabelle A in
`docs/development/MULTI-DEVICE-DEVELOPMENT.md`, einschließlich der einmaligen
expliziten Bindung mit `npm run dev:device -- PC-2` vor dem ersten Work-Start.

Der nächste empfohlene manuelle Praxistest ist das vollständige
New-Device-Onboarding auf PC 2. Danach wird eine harmlose
Dokumentationsänderung bewusst über Git zwischen PC 1, Laptop und PC 2
übergeben. Ein weiterer DB-Import-Test verwendet entbehrliche synthetische
Zieldaten oder den dokumentierten, bewusst bestätigten PC-2-Onboarding-Transfer;
die PC-1-Review-Datenbank wird niemals als destruktives Testziel verwendet.

## Workflow-Erweiterungsvalidierung

- Gerätebindung auf PC 1 wurde real angelegt; eine angeforderte PC-2-ID wurde
  abgelehnt und änderte die lokale Konfigurationsdatei nicht.
- CLI-nahe Prozessregressionen prüfen fehlende Bindungen für Work-Start und
  Work-Finish, korrekte und abweichende IDs, beschädigtes JSON sowie die
  Unveränderlichkeit einer vorhandenen Bindung. Bei einer passenden Bindung
  enthält die CLI-Ausgabe die deterministische Fehlermarke
  `git remote get-url origin ist fehlgeschlagen`, weil die Test-Sandbox bewusst
  kein Git-Repository mit `origin` enthält. Bei allen Device-bedingten Fehlern
  fehlt diese Marke. Da die Repository-Prüfung die erste nachgelagerte externe
  Befehlsgrenze ist, werden damit auch Fetch, Setup, npm,
  Tests und Docker nicht erreicht.
- Ein realer Start-Work-Aufruf mit Dirty Working Tree stoppte vor Fetch,
  Synchronisierung, npm und Docker.
- Ein DB-Import ohne exakte Bestätigung stoppte vor Toolchain-, Datei- und
  Datenbankzugriff. Ein DB-Export mit Dirty Working Tree stoppte vor
  PostgreSQL-Zugriff.
- 33 fokussierte Multi-Device-/Admin-Compose-Tests bestanden. Sie decken
  Happy-Path-Entscheidungen, falsche Geräte-ID, Dirty/Diverged Git,
  Finish-Handoff, Pfade mit Leerzeichen, Manifest/Hash, fehlende Bestätigung,
  Recovery-Primitiven, Secret-Abhängigkeiten und den bestehenden Admin-
  Bootstrap-Fix ab.
- `npm run check` bestand mit 68 Testdateien und 905 Tests; 30 Dateien und 151
  dienstgebundene Tests wurden übersprungen. Security Assessment (36 Tests),
  UAT-Struktur, Secret-Scan, npm Audit, Compose, Composer, PHP-Syntax und
  WordPress-Adaptertests bestanden ebenfalls.
- `npm run dev:check` bestand auf dem Laptop mit der gepinnten Toolchain, dem
  vollständigen Node-Gate, Composer-Validierung, PHP-Syntax,
  WordPress-Adaptertests und Compose-Konfiguration. Die gerätespezifische Env
  blieb unverändert.
- Kein Dump und kein destruktiver Import wurde gegen die aktuelle Review-
  Datenbank ausgeführt. Der vollständige Export-/Import-Praxistest bleibt für
  einen entbehrlichen synthetischen Stack reserviert.
