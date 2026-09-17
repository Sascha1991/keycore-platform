# Multi-Device-Entwicklung mit PC 1, PC 2 und Laptop

Dieser Leitfaden ist die dauerhafte Arbeitsanweisung für die lokale
KeyCore-Entwicklung auf unabhängigen Windows-Geräten. `PC-1`, `PC-2` und
`LAPTOP`
haben jeweils einen eigenen Clone, eigene Docker-Volumes, eigene Datenbanken
und eigene lokale Geheimwerte. GitHub überträgt ausschließlich committete und
gepushte Repository-Inhalte.

Der verbindliche aktuelle Gerätestand ist:

- `PC-1` ist der Haupt-PC und primäre Entwicklungsrechner. Seine bestehende
  Review-/Entwicklungsdatenbank und lokale Umgebung müssen erhalten bleiben.
- `LAPTOP` ist vollständig eingerichtet. Git/GitHub, die gepinnte Node-Version,
  Docker, der lokale Stack, die von PC 1 übertragene PostgreSQL-Review-Datenbank
  sowie Admin-Login und Review-Daten wurden bereits erfolgreich geprüft.
- `PC-2` ist der Büro-PC in der Matrix Bochum und noch kein
  KeyCore-Entwicklungsgerät. Er durchläuft später den vollständigen
  New-Device-Onboarding-Prozess in Abschnitt A.

> **Wichtig:** Git synchronisiert weder PostgreSQL-/MariaDB-Daten noch lokale
> Secrets. Nicht committete Arbeit existiert nur auf dem aktuellen PC.
> `npm run dev:stop` bewahrt alle Volumes. Das Löschen von Volumes ist
> destruktiv und gehört nicht zum normalen Arbeitsablauf.

## Codex-Kurzbefehle

In einem Codex-Task im Repository genügt genau einer dieser Human-Aufträge:

```text
Start-Work-PC-1
Finish-Work-PC-1
Start-Work-PC-2
Finish-Work-PC-2
Start-Work-Laptop
Finish-Work-Laptop
```

Codex liest `AGENTS.md` und führt dazu den passenden Repository-Befehl aus:

```powershell
npm run dev:work-start -- PC-1
npm run dev:work-finish -- PC-1
```

Für `PC-2` und `LAPTOP` wird nur die Geräte-ID ersetzt. Der Human muss die
darunterliegenden Git-, npm-, Docker-, Status-, Check-, Handoff- und
Stop-Befehle im Normalbetrieb nicht einzeln eingeben.

Jeder Clone wird genau einmal lokal gebunden:

```powershell
npm run dev:device -- PC-1
```

Die Datei `.keycore-device.json` bleibt ignoriert und enthält ausschließlich
die Workflow-ID. Sie ist weder Hardware-Fingerprint noch Authentisierung. Eine
abweichende Start-/Finish-ID bricht ab und wird niemals automatisch
überschrieben.

### Start-Work-Semantik

`dev:work-start` prüft Geräte-ID, Repository, `origin`, Working Tree und
Upstream. Bei lokalen Änderungen, fehlendem Upstream oder Divergenz stoppt es.
Es führt `git fetch origin --prune` aus und synchronisiert ausschließlich mit
`git merge --ff-only`. Danach verwendet es das bestehende `dev:setup` für
Toolchain, `npm ci`, lokale Env, Compose-Stack, Migrationen und Status. Es
meldet Branch, vollständigen Commit und `ARBEITSBEREIT`.

### Finish-Work-Semantik

`dev:work-finish` prüft die Geräte-ID, führt `dev:check` aus, aktualisiert nur
die Remote-Referenzen und zeigt den Handoff. Es erstellt niemals selbst Commit
oder Push. Nur bei sauberem, vollständig synchronem Branch stoppt es den Stack
ohne Volumes und meldet `ÜBERGABEBEREIT`. Bei Änderungen, lokalen Commits oder
Remote-Rückstand bleibt der Stack gestartet und die Übergabe blockiert.

## Schnellübersicht

| Zweck                                                  | Befehl                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| Erstinstallation prüfen und lokalen Stack einrichten   | `npm run dev:setup`                                                |
| Vollständigen Entwicklungs-Stack starten/aktualisieren | `npm run dev:start`                                                |
| Git-, Dienst- und URL-Status anzeigen                  | `npm run dev:status`                                               |
| Letzte 200 Logzeilen anzeigen                          | `npm run dev:logs`                                                 |
| Admin-Logs anzeigen                                    | `npm run dev:logs -- admin`                                        |
| Repository-, PHP- und Compose-Prüfungen ausführen      | `npm run dev:check`                                                |
| Git-Übergabestatus ohne Mutation prüfen                | `npm run dev:handoff`                                              |
| Container stoppen, Daten behalten                      | `npm run dev:stop`                                                 |
| Clone einmalig an Geräte-ID binden                     | `npm run dev:device -- PC-1`                                       |
| Arbeit sicher beginnen                                 | `npm run dev:work-start -- PC-1`                                   |
| Arbeit prüfen und sicher übergeben                     | `npm run dev:work-finish -- PC-1`                                  |
| PostgreSQL-Review-Daten exportieren                    | `npm run dev:db-export`                                            |
| PostgreSQL-Review-Daten bewusst importieren            | `npm run dev:db-import -- <dump> --confirm DESTROY-LOCAL-POSTGRES` |

Der normale Full-Stack verwendet weiterhin
`infra/docker/compose.staging.yaml` und die ausschließlich lokale Datei
`infra/docker/staging.local.env`. `dev:start` nutzt `up -d --build`, weil
Anwendungscode in die Images kopiert wird. Der Befehl ist idempotent und
verwendet vorhandene Volumes weiter.

## Voraussetzungen

- Windows 10/11 mit PowerShell.
- Git für Windows mit Git Credential Manager.
- Node.js exakt `22.22.0` und npm Major `11` (Repository-Autorität:
  `package.json`, aktuell npm `11.6.2`).
- Docker Desktop mit Linux-Containern und Compose v2; bei Bedarf WSL 2 und
  Virtualisierung gemäß Docker-Desktop-Installation aktivieren.
- Optional: GitHub CLI `gh` für die einmalige Anmeldung und PR-Arbeit.
- PHP und Composer müssen nicht auf Windows installiert sein. `dev:check`
  verwendet dafür das gepinnte Composer-Docker-Image.

`npm run dev:prerequisites` installiert nichts. Bei einer falschen
Node-Version stoppt es mit einer lesbaren Meldung. Unter Windows kann Node
`22.22.0` entweder mit dem offiziellen Installer oder mit **nvm-windows**
installiert werden. Bei nvm-windows lauten die bewussten Human-Aktionen:
`nvm install 22.22.0` und `nvm use 22.22.0`; anschließend PowerShell neu öffnen
und `node --version` sowie `npm --version` prüfen.

## A. PC 2 - New-Device-Onboarding

Dieser Abschnitt gilt künftig für den noch nicht eingerichteten Büro-PC in der
Matrix Bochum. Er gilt nicht für den bereits betriebsbereiten Laptop.

| Schritt/Situation        | Rechner | Zeitpunkt                | Wo?                      | Befehl/Aktion                                                               | Zweck                                                                                       | Erwartetes Ergebnis                                           | Bei Fehler                                                        |
| ------------------------ | ------- | ------------------------ | ------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1. Software installieren | PC 2    | einmalig                 | Windows                  | Git für Windows, Node `22.22.0`, Docker Desktop installieren; `gh` optional | Reproduzierbare Basis                                                                       | Programme starten, Docker Desktop läuft                       | Keine BIOS-/WSL-Änderung automatisieren; Herstellerhinweis prüfen |
| 2. GitHub anmelden       | PC 2    | einmalig                 | PowerShell               | `gh auth login` oder Git Credential Manager beim ersten Git-Zugriff         | HTTPS-Zugriff ohne Klartextdatei                                                            | Anmeldung für den Windows-Benutzer gespeichert                | `gh auth status` prüfen; kein Token in Dateien schreiben          |
| 3. Repository klonen     | PC 2    | einmalig                 | gewünschter Elternordner | `git clone https://github.com/Sascha1991/keycore-platform.git`              | Eigenständiger Clone                                                                        | Ordner `keycore-platform` entsteht                            | Netzwerk und GitHub-Berechtigung prüfen                           |
| 4. Repository öffnen     | PC 2    | einmalig                 | PowerShell               | `cd keycore-platform`                                                       | Befehle im Root ausführen                                                                   | `package.json` ist vorhanden                                  | Pfad korrigieren                                                  |
| 5. Zustand prüfen        | PC 2    | vor Checkout             | Repository-Root          | `git status --short --branch`                                               | Unerwartete Dateien erkennen                                                                | Frischer sauberer Clone                                       | Nicht pauschal `git clean` oder `git reset --hard` verwenden      |
| 6. Remote aktualisieren  | PC 2    | vor Checkout             | Repository-Root          | `git fetch --prune origin`                                                  | Aktuelle Branch-Kenntnis                                                                    | Fetch erfolgreich                                             | Netzwerk/Authentifizierung prüfen                                 |
| 7. Arbeitsbranch wählen  | PC 2    | je Aufgabe               | Repository-Root          | `git switch <branch>`                                                       | Richtigen Branch verwenden                                                                  | Branchname stimmt                                             | Branch mit `git branch --all` ermitteln; nichts erfinden          |
| 8. Toolchain prüfen      | PC 2    | einmalig/bei Wechsel     | Repository-Root          | `npm run dev:prerequisites`                                                 | Versionen und Docker prüfen                                                                 | Node, npm, Git, Docker und Compose werden als bereit gemeldet | Gemeldete Voraussetzung gezielt korrigieren                       |
| 9. Setup starten         | PC 2    | einmalig                 | Repository-Root          | `npm run dev:setup`                                                         | Env erzeugen, `npm ci`, Full-Stack, Migrationen, Seeds und WordPress-Bootstrap koordinieren | Alle sieben Phasen erfolgreich; keine Secrets ausgegeben      | Beim ersten Fehler stoppen; keine Volumes löschen                 |
| 10. Status prüfen        | PC 2    | nach Setup               | Repository-Root          | `npm run dev:status`                                                        | Dienste, HTTP und lokale URLs prüfen                                                        | Erforderliche Dienste `OK`; URLs sichtbar                     | `npm run dev:logs` und Abschnitt J verwenden                      |
| 11. Browser prüfen       | PC 2    | nach Setup               | Browser                  | gemeldete Storefront-, Admin- und Mailpit-URLs öffnen                       | Reale lokale Nutzbarkeit                                                                    | Storefront und Admin laden; Mailpit ist lokal erreichbar      | Portbelegung und Logs prüfen                                      |
| 12. Codex starten        | PC 2    | nach erfolgreichem Setup | Codex im Repository      | Starttext aus „Mit Codex weiterarbeiten“ verwenden                          | Repository-Kontext statt Chat-Abhängigkeit                                                  | Codex prüft Branch/Status vor Änderungen                      | Kein altes Chatprotokoll als Quellautorität verwenden             |

`dev:setup` erzeugt `infra/docker/staging.local.env` nur, wenn die Datei fehlt,
und überschreibt sie nie. Die Werte sind synthetisch, lokal und zufällig. Ein
eindeutig frischer Stack wird migriert und mit den bestehenden synthetischen
Bootstrap-/Seed-Pfaden initialisiert. Bei vollständig vorhandenen Volumes
bleiben Seed und WordPress-Bootstrap aus; ein nur teilweise vorhandener
Volume-Satz führt sicher zum Abbruch.

## B. PC 1 - Normaler Arbeitsbeginn

Normalfall in Codex: `Start-Work-PC-1`. Die Tabelle dient nur der Diagnose,
falls der automatisierte Ablauf mit einer konkreten Blockade stoppt.

| Schritt/Situation          | Rechner | Zeitpunkt                        | Wo?             | Befehl/Aktion                 | Zweck                                      | Erwartetes Ergebnis                   | Bei Fehler                                    |
| -------------------------- | ------- | -------------------------------- | --------------- | ----------------------------- | ------------------------------------------ | ------------------------------------- | --------------------------------------------- |
| 1. Repository öffnen       | PC 1    | Sitzungsbeginn                   | PowerShell      | `cd <Pfad-zum-Clone>`         | Richtigen Clone wählen                     | Repository-Root geöffnet              | Pfad prüfen                                   |
| 2. Lokalen Zustand prüfen  | PC 1    | vor Netzwerkaktion               | Repository-Root | `git status --short --branch` | Lokale Arbeit schützen                     | Branch und Änderungen sind verstanden | Unbekannte Änderungen nicht verwerfen         |
| 3. Übergabe prüfen         | PC 1    | vor Pull                         | Repository-Root | `npm run dev:handoff`         | Branch, HEAD, Upstream, Ahead/Behind lesen | Keine unerwartete Divergenz           | Bei Divergenz Abschnitt I verwenden           |
| 4. Remote aktualisieren    | PC 1    | nach sauberer Prüfung            | Repository-Root | `git fetch --prune origin`    | Remote-Wissen aktualisieren                | Fetch erfolgreich                     | Authentifizierung/Netz prüfen                 |
| 5. Fast-forward übernehmen | PC 1    | wenn sauber und richtiger Branch | Repository-Root | `git pull --ff-only`          | Keine unbeabsichtigten Merge-Commits       | Aktuell oder sauber vorgespult        | Bei Ablehnung stoppen und Divergenz prüfen    |
| 6. Stack starten           | PC 1    | nach Synchronisierung            | Repository-Root | `npm run dev:start`           | Bestehende PC-1-Daten weiterverwenden      | Full-Stack läuft; kein Reseed         | Docker/Env/Logs prüfen; keine Volumes löschen |
| 7. Bereitschaft prüfen     | PC 1    | vor Entwicklung                  | Repository-Root | `npm run dev:status`          | Reale Dienstbereitschaft                   | Dienste und HTTP-Prüfungen `OK`       | Abschnitt H/J verwenden                       |

PC 1 ist bereits initialisiert. `dev:start` und `dev:status` lesen seine
bestehende lokale Env und verwenden seine Volumes weiter. `dev:setup` darf zur
Validierung erneut laufen, behandelt vollständige vorhandene Volumes jedoch
nicht als frische Umgebung.

## C. Wechsel PC 1 zum Laptop

Normalfall: auf PC 1 `Finish-Work-PC-1`, danach auf dem Laptop
`Start-Work-Laptop`. Commit und Push bleiben bewusste Human-Anweisungen; ohne
synchronen Git-Stand meldet Finish keine Übergabebereitschaft.

| Schritt/Situation        | Rechner          | Zeitpunkt             | Wo?             | Befehl/Aktion                                                  | Zweck                                   | Erwartetes Ergebnis                       | Bei Fehler                                                             |
| ------------------------ | ---------------- | --------------------- | --------------- | -------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| 1. Änderungen prüfen     | PC 1             | vor Wechsel           | Repository-Root | `git status --short` und `git diff --check`                    | Umfang und Whitespace prüfen            | Nur beabsichtigte Dateien                 | Unbekannte/secret-nahe Dateien ausschließen                            |
| 2. Passende Tests        | PC 1             | vor Commit            | Repository-Root | fokussierte Tests, danach je Risiko `npm run dev:check`        | Übergabefähigen Stand sichern           | Prüfungen grün                            | Fehler vor Übergabe beheben oder klar dokumentieren                    |
| 3. Gezielt stagen        | PC 1             | vor Commit            | Repository-Root | `git add <datei1> <datei2>`                                    | Keine pauschale Secret-Aufnahme         | Staging enthält nur beabsichtigte Dateien | `git diff --cached --name-only` prüfen; nicht `git add .` als Standard |
| 4. Commit und Push       | PC 1             | vor Wechsel           | Repository-Root | `git commit -m "<aussagekräftige Nachricht>"`, dann `git push` | Getrackte Arbeit nach GitHub übertragen | Push nennt aktuellen Branch/Commit        | Push-Fehler nicht mit Force umgehen                                    |
| 5. Remote bestätigen     | PC 1             | direkt nach Push      | Repository-Root | `npm run dev:handoff`                                          | Ahead/Behind kontrollieren              | `voraus 0, zurück 0`                      | Upstream/Push prüfen                                                   |
| 6. Optional stoppen      | PC 1             | Arbeitsende           | Repository-Root | `npm run dev:stop`                                             | Ressourcen freigeben                    | Container aus, Volumes bleiben            | Nicht `down --volumes` ausführen                                       |
| 7. Gerät wechseln        | PC 1 oder Laptop | nach bestätigtem Push | physisch        | Von PC 1 zum Laptop wechseln                                   | Übergabegrenze                          | GitHub enthält Commit                     | Ohne Push ist Arbeit nicht auf dem Laptop                              |
| 8. Laptop-Zustand prüfen | Laptop           | vor Pull              | Repository-Root | `git status --short --branch`, `npm run dev:handoff`           | Lokale Laptop-Arbeit schützen           | Zustand verstanden                        | Bei Änderungen zuerst entscheiden/committen                            |
| 9. Aktualisieren         | Laptop           | bei sauberem Zustand  | Repository-Root | `git fetch --prune origin`, dann `git pull --ff-only`          | Commit übernehmen                       | Fast-forward erfolgreich                  | Bei Divergenz stoppen                                                  |
| 10. Start und Status     | Laptop           | nach Pull             | Repository-Root | `npm run dev:start`, dann `npm run dev:status`                 | Bestehenden lokalen Stack nutzen        | Laptop-Dienste bereit                     | Abschnitte H bis K verwenden                                           |

PC 1 muss technisch nicht ausgeschaltet sein. Das Stoppen ist nur eine
Ressourcen-/Verwechslungsentscheidung; es überträgt keine Daten.

## D. Laptop - Normaler Arbeitsbeginn

Normalfall in Codex: `Start-Work-Laptop`. Die Einzelschritte unten sind
ausschließlich Diagnose/Fallback.

| Schritt/Situation        | Rechner | Zeitpunkt                              | Wo?             | Befehl/Aktion                                        | Zweck                        | Erwartetes Ergebnis                          | Bei Fehler                              |
| ------------------------ | ------- | -------------------------------------- | --------------- | ---------------------------------------------------- | ---------------------------- | -------------------------------------------- | --------------------------------------- |
| 1. Clone öffnen          | Laptop  | Sitzungsbeginn                         | PowerShell      | `cd <Pfad-zum-Clone>`                                | Richtige Arbeitskopie        | Root geöffnet                                | Pfad prüfen                             |
| 2. Zustand/Branch prüfen | Laptop  | vor Fetch                              | Repository-Root | `git status --short --branch`, `npm run dev:handoff` | Lokale Arbeit erkennen       | Branch korrekt, keine unerklärten Änderungen | Änderungen nicht blind stashen          |
| 3. Remote-Wissen holen   | Laptop  | nach Prüfung                           | Repository-Root | `git fetch --prune origin`                           | GitHub-Stand sehen           | Fetch erfolgreich                            | Netzwerk/Anmeldung prüfen               |
| 4. Sicher aktualisieren  | Laptop  | bei sauberem, nicht divergentem Branch | Repository-Root | `git pull --ff-only`                                 | Lineare Übergabe             | Aktuell/fast-forward                         | Abschnitt I                             |
| 5. Umgebung starten      | Laptop  | nach Pull                              | Repository-Root | `npm run dev:start`                                  | Bestehende Volumes verwenden | Stack läuft                                  | Docker Desktop starten bzw. Logs prüfen |
| 6. Bereitschaft prüfen   | Laptop  | vor Arbeit                             | Repository-Root | `npm run dev:status`                                 | Dienste/URLs bestätigen      | Alles Erforderliche `OK`                     | Abschnitt H/J                           |

Der Laptop ist kein Onboarding-Ziel mehr. `dev:setup` ist dort nicht Teil des
normalen Starts; `Start-Work-Laptop` verwendet die bestehende lokale Umgebung.

## E. Wechsel Laptop zu PC 1

Normalfall: auf dem Laptop `Finish-Work-Laptop`, danach auf PC 1
`Start-Work-PC-1`.

| Schritt/Situation    | Rechner | Zeitpunkt            | Wo?             | Befehl/Aktion                                                   | Zweck                      | Erwartetes Ergebnis                  | Bei Fehler                   |
| -------------------- | ------- | -------------------- | --------------- | --------------------------------------------------------------- | -------------------------- | ------------------------------------ | ---------------------------- |
| 1. Diff und Tests    | Laptop  | vor Wechsel          | Repository-Root | `git status --short`, `git diff --check`, passende Tests        | Qualität und Umfang prüfen | Nur beabsichtigte Arbeit             | Fehler beheben/dokumentieren |
| 2. Gezielt committen | Laptop  | nach Tests           | Repository-Root | `git add <dateien>`; Diff prüfen; `git commit -m "<Nachricht>"` | Sichere Übergabeeinheit    | Commit enthält keine lokalen Secrets | Staging-Diff korrigieren     |
| 3. Push und Prüfung  | Laptop  | vor Wechsel          | Repository-Root | `git push`, danach `npm run dev:handoff`                        | GitHub aktualisieren       | Ahead/Behind jeweils 0               | Kein Force-Push als Routine  |
| 4. Optional stoppen  | Laptop  | Arbeitsende          | Repository-Root | `npm run dev:stop`                                              | Ressourcen freigeben       | Daten bleiben erhalten               | Keine Volumes löschen        |
| 5. Zustand prüfen    | PC 1    | nach Wechsel         | Repository-Root | `git status --short --branch`, `npm run dev:handoff`            | PC-1-Arbeit schützen       | Zustand verstanden                   | Lokale Arbeit zuerst sichern |
| 6. Fetch/Pull        | PC 1    | bei sauberem Zustand | Repository-Root | `git fetch --prune origin`; `git pull --ff-only`                | Laptop-Commit übernehmen   | Fast-forward                         | Divergenz bewusst klären     |
| 7. Start/Status      | PC 1    | nach Pull            | Repository-Root | `npm run dev:start`; `npm run dev:status`                       | PC-1-Stack fortsetzen      | Bereit                               | Abschnitte H bis K           |

## F. Arbeitsende ohne Gerätewechsel

Normalfall: `Finish-Work-PC-1`, `Finish-Work-PC-2` oder
`Finish-Work-Laptop`. Bei nicht committierter oder nicht gepushter Arbeit
bleibt die Übergabe bewusst blockiert und der Stack läuft weiter.

| Schritt/Situation                | Rechner                | Zeitpunkt   | Wo?             | Befehl/Aktion                                                    | Zweck                               | Erwartetes Ergebnis                | Bei Fehler                                                 |
| -------------------------------- | ---------------------- | ----------- | --------------- | ---------------------------------------------------------------- | ----------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| Fertige Arbeit                   | PC 1, PC 2 oder Laptop | Arbeitsende | Repository-Root | testen, gezielt stagen, committen und `git push`                 | GitHub-Backup/Handoff               | Remote synchron                    | Push-Fehler klären                                         |
| Unfertige, aber kohärente Arbeit | PC 1, PC 2 oder Laptop | Arbeitsende | Repository-Root | WIP-Commit auf dem Arbeitsbranch mit klarer Nachricht, dann Push | Sicherer geräteübergreifender Stand | Commit auf GitHub                  | Keine Secrets/kaputten gemeinsamen Branch ungeprüft pushen |
| Rein lokale, unfertige Arbeit    | PC 1, PC 2 oder Laptop | kurze Pause | Repository-Root | Dateien unverändert lassen und den PC nicht wechseln             | Kein künstlicher Commit             | Arbeit bleibt nur lokal            | Vor Gerätewechsel zwingend committen/pushen                |
| Laufzeit stoppen                 | PC 1, PC 2 oder Laptop | optional    | Repository-Root | `npm run dev:stop`                                               | Docker-Ressourcen freigeben         | Container gestoppt, Daten erhalten | Normalen Stop nicht durch Volume-Löschung ersetzen         |

## G. Tests und Prüfungen

| Schritt/Situation              | Rechner                | Zeitpunkt               | Wo?             | Befehl/Aktion                                               | Zweck                                                | Erwartetes Ergebnis   | Bei Fehler                      |
| ------------------------------ | ---------------------- | ----------------------- | --------------- | ----------------------------------------------------------- | ---------------------------------------------------- | --------------------- | ------------------------------- |
| Fokussierte Änderung           | PC 1, PC 2 oder Laptop | während Entwicklung     | Repository-Root | `npx vitest run <testdatei>`                                | Schnelles Feedback                                   | Betroffene Tests grün | Ursache im Scope beheben        |
| Normale Repository-Prüfung     | PC 1, PC 2 oder Laptop | vor Commit/Push         | Repository-Root | `npm run check`                                             | Format, Lint, Typen, Tests, Secret-Scan              | Alle Gates grün       | Nicht überspringen              |
| Plattformübergreifende Prüfung | PC 1, PC 2 oder Laptop | vor PR                  | Repository-Root | `npm run dev:check`                                         | `npm run check`, PHP/WordPress im Container, Compose | Alle drei Ebenen grün | Docker/konkretes Gate prüfen    |
| UAT-Struktur                   | PC 1, PC 2 oder Laptop | bei UAT-Doku            | Repository-Root | `npm run uat:validate`                                      | Matrixkonsistenz                                     | Validierung grün      | Keine Human-Ergebnisse erfinden |
| E2E/Security                   | PC 1, PC 2 oder Laptop | bei betroffenen Grenzen | Repository-Root | `npm run e2e:acceptance` bzw. `npm run security:assessment` | Breite Verhaltens-/Security-Evidenz                  | Suites grün           | Scope und Abhängigkeiten prüfen |

## H. Status, Logs und Diagnose

| Schritt/Situation | Rechner                | Zeitpunkt         | Wo?             | Befehl/Aktion                                                                                      | Zweck                            | Erwartetes Ergebnis          | Bei Fehler                                                                                       |
| ----------------- | ---------------------- | ----------------- | --------------- | -------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Gesamtstatus      | PC 1, PC 2 oder Laptop | jederzeit         | Repository-Root | `npm run dev:status`                                                                               | Git, Compose, Health, HTTP, URLs | Alle erwarteten Dienste `OK` | Betroffenen Dienst isolieren                                                                     |
| Begrenzte Logs    | PC 1, PC 2 oder Laptop | bei Fehler        | Repository-Root | `npm run dev:logs`                                                                                 | Letzte 200 Zeilen aller Dienste  | Diagnose ohne Endlosstream   | Docker Desktop prüfen                                                                            |
| Dienstlogs        | PC 1, PC 2 oder Laptop | bei Einzelproblem | Repository-Root | `npm run dev:logs -- admin`                                                                        | Admin gezielt prüfen             | Nur `keycore-admin`          | Erlaubte Aliase: `admin`, `storefront`, `wordpress`, `wordpress-db`, `postgres`, `redis`, `mail` |
| Rohstatus         | PC 1, PC 2 oder Laptop | tiefe Diagnose    | Repository-Root | `docker compose --env-file infra/docker/staging.local.env -f infra/docker/compose.staging.yaml ps` | Compose-Details                  | Containerzustände sichtbar   | Env/Pfad prüfen                                                                                  |

## I. Git-Fehler und Sonderfälle

| Schritt/Situation           | Rechner                | Zeitpunkt        | Wo?             | Befehl/Aktion                                                             | Zweck                      | Erwartetes Ergebnis                              | Bei Fehler                                                         |
| --------------------------- | ---------------------- | ---------------- | --------------- | ------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| Uncommittete Änderungen     | PC 1, PC 2 oder Laptop | vor Pull/Wechsel | Repository-Root | `git status --short`; Diff einzeln prüfen                                 | Lokale Arbeit verstehen    | Klare Zuordnung                                  | Committen oder auf diesem PC weiterarbeiten; nicht blind verwerfen |
| Unerwartete untracked Datei | PC 1, PC 2 oder Laptop | vor Stage        | Repository-Root | Dateiname/Herkunft klären, `git check-ignore -v -- <pfad>`                | Secret-Aufnahme verhindern | Datei bewusst ignoriert oder bewusst aufgenommen | Kein pauschales `git add .`                                        |
| Falscher Branch             | PC 1, PC 2 oder Laptop | vor Arbeit       | Repository-Root | `git branch --show-current`; erst bei sauberem Tree `git switch <branch>` | Richtige Historie          | Erwarteter Branch                                | Änderungen vor Wechsel sichern                                     |
| Lokale Commits voraus       | PC 1, PC 2 oder Laptop | Übergabe         | Repository-Root | `npm run dev:handoff`; anschließend beabsichtigten Branch `git push`      | Commits veröffentlichen    | Ahead 0                                          | Upstream/Berechtigung prüfen                                       |
| Remote-Commits fehlen       | PC 1, PC 2 oder Laptop | Arbeitsbeginn    | Repository-Root | `git fetch --prune origin`; `git pull --ff-only`                          | Sicher aktualisieren       | Fast-forward                                     | Bei lokaler Arbeit stoppen                                         |
| Divergenz                   | PC 1, PC 2 oder Laptop | nach Fetch       | Repository-Root | `git log --oneline --left-right HEAD...@{upstream}`                       | Beide Seiten verstehen     | Ursache identifiziert                            | Nicht resetten/forcen; Rebase/Merge bewusst mit Reviewer planen    |
| Merge-/Rebase-Konflikt      | PC 1, PC 2 oder Laptop | Ausnahme         | Repository-Root | Konfliktdateien und Git-Status lesen                                      | Bewusste Auflösung         | Tests danach grün                                | Keine destruktive Einzeiler-Reparatur                              |
| GitHub nicht erreichbar     | PC 1, PC 2 oder Laptop | Fetch/Push       | Repository-Root | Netzwerk und `gh auth status`/Credential Manager prüfen                   | Ursache trennen            | Zugriff wiederhergestellt                        | Lokale Commits bleiben erhalten                                    |
| Push abgelehnt              | PC 1, PC 2 oder Laptop | Übergabe         | Repository-Root | `git fetch`; Divergenz prüfen                                             | Remote-Arbeit schützen     | Bewusste Synchronisierung                        | Kein `--force` als Routine                                         |

## J. Docker- und Startprobleme

| Schritt/Situation       | Rechner                | Zeitpunkt    | Wo?             | Befehl/Aktion                                                                                                  | Zweck                  | Erwartetes Ergebnis                   | Bei Fehler                                                    |
| ----------------------- | ---------------------- | ------------ | --------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------- | ------------------------------------------------------------- |
| Docker geschlossen      | PC 1, PC 2 oder Laptop | vor Start    | Windows         | Docker Desktop starten; `docker info`                                                                          | Engine bereitstellen   | Serverinformationen sichtbar          | WSL2/Virtualisierung/Installation prüfen                      |
| Port belegt             | PC 1, PC 2 oder Laptop | Startfehler  | PowerShell      | `Get-NetTCPConnection -State Listen` und gemeldeten Port zuordnen                                              | Kollision finden       | Besitzer bekannt                      | Fremden Dienst bewusst stoppen oder lokale Portwerte anpassen |
| Compose ungültig        | PC 1, PC 2 oder Laptop | Start/Check  | Repository-Root | `docker compose --env-file infra/docker/staging.local.env -f infra/docker/compose.staging.yaml config --quiet` | Env/Compose validieren | Exit 0                                | Fehlende Variable ergänzen, Datei nicht ersetzen              |
| Dienst unhealthy/exited | PC 1, PC 2 oder Laptop | Statusfehler | Repository-Root | `npm run dev:logs -- <alias>`                                                                                  | Konkrete Ursache       | Relevante bounded Logs                | Keine Volumes als erste Maßnahme löschen                      |
| Lokale Env fehlt        | PC 1, PC 2 oder Laptop | Startfehler  | Repository-Root | `npm run dev:setup`                                                                                            | Sicher erzeugen        | Datei entsteht ohne Ausgabe der Werte | Bestehende Datei nie überschreiben                            |

## K. Datenbank- und Migrationsprobleme

| Schritt/Situation        | Rechner                | Zeitpunkt             | Wo?             | Befehl/Aktion                                             | Zweck                                                                     | Erwartetes Ergebnis                | Bei Fehler                                           |
| ------------------------ | ---------------------- | --------------------- | --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| PostgreSQL nicht bereit  | PC 1, PC 2 oder Laptop | Start/Setup           | Repository-Root | `npm run dev:status`; `npm run dev:logs -- postgres`      | Health statt Port raten                                                   | Ursache sichtbar                   | Env/Disk/Docker prüfen                               |
| Migrationen prüfen       | PC 1, PC 2 oder Laptop | nach Pull             | Repository-Root | `npm run dev:setup`                                       | Bestehender Stack migriert über autoritativen Bootstrap und meldet Status | Migrationen current, keine Reseeds | Fehler stoppen; kein Auto-Rollback                   |
| Migration fehlgeschlagen | PC 1, PC 2 oder Laptop | Setup                 | Repository-Root | Ausgabe sichern, `npm run dev:logs -- postgres`           | Ursache analysieren                                                       | Keine weiteren Mutationen          | Nicht automatisch `db:rollback`/Volumes löschen      |
| Restore inkompatibel     | PC 2                   | nach optionaler Kopie | Repository-Root | Quell-Commit, Dump-Checksumme und Migrationen vergleichen | Versionsfehler erkennen                                                   | Passender Git-Stand                | Restore abbrechen bzw. frischen PC-2-Stack verwenden |
| Zustand unerwartet       | PC 1, PC 2 oder Laptop | jederzeit             | Repository-Root | Arbeit stoppen, Status/Dump-Metadaten dokumentieren       | Daten schützen                                                            | Ursache vor Mutation verstanden    | Keine Ad-hoc-SQL-Reparatur ohne Projektanweisung     |

## L. Bewusster PostgreSQL-Review-Datentransfer

Der Transfer von PC 1 zum Laptop wurde bereits erfolgreich durchgeführt und
human-verifiziert. Der nächste New-Device-Anwendungsfall ist PC 2. Die
folgenden Regeln gelten für einen erneuten bewussten Transfer auf ein
Zielgerät; sie sind kein normaler Start-/Finish-Schritt.

Diese fortgeschrittene, bewusste Operation kopiert nur KeyCore-PostgreSQL. Sie
kopiert **nicht** WordPress/MariaDB, Redis, Secrets oder Docker-Volumes. Zuerst
müssen beide Clones denselben Commit verwenden. Der Dump darf weder in Git noch
in einen ungeschützten öffentlichen Speicher gelangen.

Der autoritative Export ist:

```powershell
npm run dev:db-export
```

Er prüft PostgreSQL, erzeugt einen konsistenten Custom-Format-Dump außerhalb
des Repositories (standardmäßig `$HOME\KeyCore-Transfers`), entfernt die
temporäre Containerdatei und schreibt SHA-256 plus nicht-sensitives Manifest
mit Branch, Commit und Migrationstand. Ein abweichender Zielordner kann als
erstes Argument angegeben werden; Pfade mit Leerzeichen werden ohne
Shell-Stringverkettung verarbeitet.

Nach bewusstem, privatem Dateitransfer ist der autoritative Import:

```powershell
npm run dev:db-import -- "C:\Pfad mit Leerzeichen\keycore-postgres-transfer.dump" --confirm DESTROY-LOCAL-POSTGRES
```

Der Import verlangt Dump, `.sha256`, `.manifest.json`, passenden Hash,
Repository-Identität und einen Dump-Commit, der Vorfahr des aktuellen HEAD ist.
Vor der ersten destruktiven Datenbankaktion wird automatisch ein vollständiges
`pre-import-recovery`-Paket neben dem Dump erzeugt. Danach werden PostgreSQL-
Writer gestoppt und `pg_restore` läuft mit `--no-owner --no-privileges
--exit-on-error`. Bei Fehler wird automatisch das Sicherheitsbackup
wiederhergestellt; schlägt auch das fehl, bleiben Writer gestoppt und der
Backup-Pfad wird gemeldet. Erfolgreich importierte Daten werden migriert,
gestartet und mit `dev:status` validiert.

Die nachfolgende Low-Level-Tabelle erklärt nur die zugrunde liegenden
Recovery-Schritte. Im Normalbetrieb werden diese Befehle nicht manuell
ausgeführt.

Für die Nutzbarkeit bestimmter restaurierter Datensätze bestehen zwei echte
kryptografische/Bootstrap-Abhängigkeiten mit insgesamt drei Variablen:

- `KEYRANO_STAGING_GUEST_CLAIM_CODE` muss übernommen werden, solange das feste
  synthetische Guest-Claim-Fixture im Dump vorhanden ist. Der Checkout-Bootstrap
  vergleicht dessen persistierten Hash mit der lokalen Konfiguration und bricht
  bei einer Abweichung fail-closed ab.
- `KEYCORE_FULFILLMENT_MASTER_KEY` und
  `KEYCORE_FULFILLMENT_MASTER_KEY_ID` müssen zusammen übernommen werden, wenn
  bereits persistiertes verschlüsseltes Fulfillment-Material auf PC 2 lesbar
  bleiben soll. Ohne das passende Schlüsselpaar bleibt es absichtlich
  unlesbar.

`KEYRANO_STAGING_BROWSER_MASTER_KEY` wird nicht übertragen. Er schützt nur das
bei jedem Storefront-Start neu erzeugte In-Memory-Browser-Fixture und hat keine
PostgreSQL-Abhängigkeit. Auch Admin-Session-, Cursor-, CSRF-, Bridge-, Stripe-,
Redis-, WordPress- und andere lokale Secrets bleiben gerätespezifisch. Keine
Werte in Chat, Screenshots, Shell-History, Git oder Dokumentation einfügen.

Ein PostgreSQL-Restore übernimmt den Hash der bestehenden
Admin-Passwortberechtigung sowie deren E-Mail-Identity. Normales Bootstrap
erzeugt beides nur, wenn das feste synthetische Admin-Credential noch fehlt;
bei einer bestehenden oder restaurierten Berechtigung werden weder E-Mail,
Status noch Passwort-Hash aus der gerätelokalen Env übernommen. Der
`KEYRANO_STAGING_ADMIN_SESSION_HASH_SECRET` darf deshalb PC-2-lokal bleiben:
übertragene Sessions werden damit zwar nicht weiterverwendet, ein neuer Login
mit dem restaurierten Credential funktioniert aber unabhängig davon.

Statt das PC-1-Passwort zu übertragen, verwendet der Human nach dem Restore den
vorhandenen lokalen `Passwort vergessen?`-Ablauf und Mailpit. Eine bewusste
Rotation auf das in der lokalen Env konfigurierte Passwort ist ausschließlich
über einen expliziten Einmal-Lauf zulässig; die restaurierte E-Mail bleibt
dabei erhalten:

```powershell
docker compose --env-file infra/docker/staging.local.env -f infra/docker/compose.staging.yaml run --rm --build -e KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD_ROTATE=true keycore-admin-bootstrap
```

Die lokale Env behält dauerhaft
`KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD_ROTATE=false`; `dev:start` und
`dev:setup` lehnen einen anderen Dauerwert ab. WordPress-Anmeldungen bleiben
PC-2-lokal, da MariaDB nicht restauriert wird.

In den folgenden Befehlen wird `$compose` nur als PowerShell-Argumentliste
verwendet:

```powershell
$compose = @("compose", "--env-file", "infra/docker/staging.local.env", "-f", "infra/docker/compose.staging.yaml")
```

| Schritt/Situation               | Rechner                | Zeitpunkt                   | Wo?                                     | Befehl/Aktion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Zweck                                                         | Erwartetes Ergebnis                                                          | Bei Fehler                                                                                                                            |
| ------------------------------- | ---------------------- | --------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Git-Stand bestätigen         | PC 1, PC 2 oder Laptop | vor Dump                    | jeweiliger Root                         | Auf PC 1 und danach auf PC 2 jeweils `git rev-parse HEAD` ausführen                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Schema-/Code-Parität                                          | Identische SHA                                                               | Erst normale Git-Übergabe abschließen                                                                                                 |
| 2. Writer pausieren             | PC 1                   | vor Dump                    | Repository-Root                         | `docker @compose stop keycore-admin keycore-storefront wordpress`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Konsistenter Dump                                             | Writer gestoppt, PostgreSQL läuft                                            | Logs prüfen; nicht Volumes löschen                                                                                                    |
| 3. Dump im Container erzeugen   | PC 1                   | nach Pause                  | Repository-Root                         | `docker @compose exec -T postgres pg_dump -U keycore_staging -d keycore_staging -Fc -f /tmp/keycore-postgres.dump`                                                                                                                                                                                                                                                                                                                                                                                                                 | Binärdump ohne PowerShell-Pipekorruption                      | Exit 0                                                                       | PostgreSQL-Log prüfen                                                                                                                 |
| 4. Dump herauskopieren          | PC 1                   | nach Dump                   | Repository-Root                         | `$pg = docker @compose ps -q postgres`; `New-Item -ItemType Directory -Force "$HOME\KeyCore-Transfers"`; `docker cp "${pg}:/tmp/keycore-postgres.dump" "$HOME\KeyCore-Transfers\keycore-postgres-transfer.dump"`; `docker @compose exec -T postgres rm -f /tmp/keycore-postgres.dump`                                                                                                                                                                                                                                              | Lokale Transferdatei                                          | Dump nur im Transferordner                                                   | Pfad/Container-ID prüfen                                                                                                              |
| 5. Checksumme erstellen         | PC 1                   | direkt danach               | PowerShell                              | `Get-FileHash "$HOME\KeyCore-Transfers\keycore-postgres-transfer.dump" -Algorithm SHA256`; Ergebnis optional in einer gleichnamigen `.sha256`-Datei außerhalb Git sichern                                                                                                                                                                                                                                                                                                                                                          | Integrität                                                    | SHA-256 vorhanden                                                            | Dump neu erzeugen                                                                                                                     |
| 6. PC 1 wieder starten          | PC 1                   | nach Kopie                  | Repository-Root                         | `npm run dev:start`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | PC 1 normal fortsetzen                                        | Status bereit                                                                | Logs prüfen                                                                                                                           |
| 7. Geschützt übertragen         | PC 1, PC 2 oder Laptop | nach Checksumme             | außerhalb Git                           | Dump bewusst von PC 1 zu PC 2 über einen privaten/verschlüsselten Datenträger übertragen                                                                                                                                                                                                                                                                                                                                                                                                                                           | Bewusster Datentransfer                                       | Datei auf PC 2                                                               | Nie committen oder öffentlich teilen                                                                                                  |
| 8. Checksumme prüfen            | PC 2                   | vor Restore                 | PowerShell                              | `Get-FileHash <dump-pfad> -Algorithm SHA256`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Manipulation/Defekt erkennen                                  | Exakte Übereinstimmung                                                       | Bei Abweichung STOP                                                                                                                   |
| 9. Erforderliche Konfiguration  | PC 2                   | vor Restore                 | lokaler Secret-Editor/geschützter Kanal | Den Guest-Claim-Wert und, falls verschlüsseltes Fulfillment-Material weiter lesbar sein muss, Fulfillment-Master-Key samt ID sicher von PC 1 nach `infra/docker/staging.local.env` auf PC 2 übertragen; Browser- und Admin-Secrets nicht kopieren; Werte nie in Befehle/Chat einfügen                                                                                                                                                                                                                                              | Restaurierte Fixture-/Ciphertext-Kompatibilität               | Höchstens die drei begründeten Variablen übernommen, Werte bleiben verborgen | Bei fehlendem Guest-Claim-Wert Restore verschieben; verschlüsseltes Material ohne passendes Schlüsselpaar als nicht nutzbar behandeln |
| 10. PC-2-Backup/Bestätigung     | PC 2                   | vor destruktivem Restore    | Repository-Root                         | Bestehende PC-2-Daten bewusst als entbehrlich bestätigen oder vorher gleichartig dumpen                                                                                                                                                                                                                                                                                                                                                                                                                                            | Zielverlust bewusst machen                                    | Human bestätigt nur PC-2-Ziel                                                | Bei Unsicherheit STOP                                                                                                                 |
| 11. Writer pausieren            | PC 2                   | vor Restore                 | Repository-Root                         | `docker @compose stop keycore-admin keycore-storefront wordpress`; `$pg = docker @compose ps -q postgres`; `docker cp <dump-pfad> "${pg}:/tmp/keycore-postgres.dump"`                                                                                                                                                                                                                                                                                                                                                              | Restore vorbereiten                                           | Dump im PC-2-Container                                                       | Pfad prüfen                                                                                                                           |
| 12. Nur PC-2-Datenbank ersetzen | PC 2                   | nach expliziter Bestätigung | Repository-Root                         | `docker @compose exec -T postgres psql -U keycore_staging -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='keycore_staging' AND pid <> pg_backend_pid();"`; danach `docker @compose exec -T postgres dropdb -U keycore_staging keycore_staging`; `docker @compose exec -T postgres createdb -U keycore_staging keycore_staging`; `docker @compose exec -T postgres pg_restore -U keycore_staging -d keycore_staging --no-owner --no-privileges /tmp/keycore-postgres.dump` | Kontrollierter Restore ausschließlich auf PC 2                | `pg_restore` Exit 0                                                          | STOP; keine Seeds oder Reparatur-SQL starten                                                                                          |
| 13. Aufräumen und prüfen        | PC 2                   | nach Restore                | Repository-Root                         | `docker @compose exec -T postgres rm -f /tmp/keycore-postgres.dump`; `npm run dev:start`; `npm run dev:status`; `npm run dev:setup` nur zum Migrations-/Kompatibilitätscheck; Admin-Passwort bei Bedarf über lokale Mailpit zurücksetzen                                                                                                                                                                                                                                                                                           | Dump entfernen, Dienste, Migrationen und lokalen Login prüfen | Status bereit; bestehende Volumes erkannt, kein Reseed                       | Logs, Key-Abhängigkeiten und Commit-Kompatibilität prüfen                                                                             |

## M. Was tun, wenn sich das Projekt geändert hat?

| Schritt/Situation            | Rechner                | Zeitpunkt | Wo?             | Befehl/Aktion                                                                                                                     | Zweck                                                | Erwartetes Ergebnis                            | Bei Fehler                                  |
| ---------------------------- | ---------------------- | --------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `package-lock.json` geändert | PC 1, PC 2 oder Laptop | nach Pull | Repository-Root | `npm ci` oder umfassend `npm run dev:setup`                                                                                       | Exakte Abhängigkeiten                                | Lockfile unverändert, Installation erfolgreich | npm-/Node-Version prüfen                    |
| Migration hinzugekommen      | PC 1, PC 2 oder Laptop | nach Pull | Repository-Root | `npm run dev:setup`                                                                                                               | Pending Migration über vorhandene Autorität anwenden | DB current                                     | Kein Reset/Auto-Rollback                    |
| Dockerfile/Compose geändert  | PC 1, PC 2 oder Laptop | nach Pull | Repository-Root | `npm run dev:start`                                                                                                               | Images neu bauen                                     | Dienste bereit                                 | `dev:logs`, Compose config                  |
| Env-Template geändert        | PC 1, PC 2 oder Laptop | nach Pull | Repository-Root | `npm run dev:start` bzw. `dev:setup` zur Validierung; fehlende Variable gezielt aus `infra/docker/staging.env.example` übernehmen | Bestehende Secrets bewahren                          | Validierung ohne Template-Drift                | Env nie komplett überschreiben              |
| WordPress-Bootstrap geändert | PC 1, PC 2 oder Laptop | nach Pull | Repository-Root | Änderung/Release-Hinweis prüfen; nur bei ausdrücklich sicherer/idempotenter Anweisung den dokumentierten Bootstrap ausführen      | Human-Inhalte schützen                               | Bewusste Aktualisierung                        | Nicht automatisch auf Review-Daten anwenden |

## N. Checklisten PC 1, PC 2 und Laptop

### Bevor ich anfange

- Einmalige Gerätebindung stimmt: `npm run dev:device -- PC-1|PC-2|LAPTOP`.
- Codex-Auftrag `Start-Work-<Gerät>` ist mit `ARBEITSBEREIT` abgeschlossen.

### Bevor ich den Rechner wechsle

- Beabsichtigte Änderungen wurden Human-gesteuert committed und gepusht.
- Codex-Auftrag `Finish-Work-<Gerät>` meldet `ÜBERGABEBEREIT`.
- Bei einer Blockade bleibt die Arbeit lokal erhalten und der Stack gestartet.

### Bevor ich den Rechner ausschalte

- Entscheiden, ob lokaler Stand auf GitHub verfügbar sein muss.
- Nicht committete Arbeit ist ausschließlich lokal.
- `npm run dev:stop` ist sicher; Docker-Volumes niemals als Routine löschen.

## Mit Codex auf PC 1, PC 2 oder Laptop weiterarbeiten

Ein frischer Codex-Task benötigt keinen Export dieses Chats. Empfohlener erster
Auftrag: `Start-Work-PC-1`, `Start-Work-PC-2` oder `Start-Work-Laptop`. Codex
übersetzt ihn gemäß `AGENTS.md` in den passenden Repository-Befehl. Zum Ende
wird entsprechend `Finish-Work-...` verwendet.

Der aktuelle Admin-Panel-Fortschritt bleibt in
`docs/implementation-reports/ADMIN-PANEL-V1-1.md` und
`docs/uat/admin-panel-v1-readiness.md` authoritative; GitHub-Branch und PR
liefern den aktuellen Review-Kontext. Ein alter Branchname in einem Beispiel
ist keine permanente Arbeitsanweisung.

## Designreferenzen

Die 13 während Admin Panel V1.1 verwendeten externen Referenzbilder wurden für
Portabilität klassifiziert. Sie bleiben `EXTERNAL_ONLY`: Einige enthalten
identifizierbare Personen-/Profildarstellung, Beispielkontaktdaten und
Marken-/Produktgrafiken, deren Repository-Rechte nicht belegt sind. Deshalb
werden weder Originale noch abgeleitete Kopien ungeprüft committed. Der
funktionale und akzeptierte Stand ist in den bestehenden Admin-Berichten und
Tests dokumentiert. Für eine spätere visuelle Kategorie muss der Human die
benötigten Referenzen auf PC 2 erneut ausdrücklich bereitstellen oder eine
bereinigte, freigegebene Repository-Version autorisieren.

## Sicherheitsgrenzen

- `Server Login Staging Daten.txt` und `infra/docker/staging.local.env` bleiben
  ignoriert, ungelesen und ungetrackt.
- Lokale Env-/Dump-Dateien werden nicht gepusht; echte Produktionswerte sind
  im lokalen Entwicklungsstack verboten.
- Der Stack bleibt `STAGING`, Supplier `MOCK`, Stripe `TEST`, externe Mail
  deaktiviert und Operations Authority `DISABLED`.
- Setup, Start und Status deployen nichts. Human-UAT- und Approval-Zustände
  werden durch diese Entwicklerwerkzeuge nicht verändert.

Wenn Befehle, Voraussetzungen oder Compose-Architektur geändert werden, muss
dieser Leitfaden in derselben Änderung aktualisiert werden.
