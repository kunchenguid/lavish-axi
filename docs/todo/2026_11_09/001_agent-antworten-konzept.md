# Konzept: Verankerte Agent-Antworten auf Annotationen

Datum: 2026-11-09 · Status: beschlossen (Simon), Plan v4 nach Team-Red-Runde 2 (Transportvertrag zweistufig festgelegt), Umsetzung offen · Bezugsfläche: Session `3e43893f33de07d9` (GTMAudit-Wissensinsel, sanctum-os)

## Ziel

Simon annotiert Stellen im Artifact mit Fragen. Der Agent, der die Fläche über den Poll betreut, soll direkt an denselben Stellen antworten können: inline im Text als Sprechblase, in der Konversationsleiste rechts in eigener Farbe, lesbar per Hover und Klick. Fragen durchlaufen einen sichtbaren Lebenszyklus.

## Zustandsmodell (beschlossen)

Jede Annotation hat drei Zustände:

| Zustand     | Übergang                                                                                         | Farbe Marke/Bubble                           | Symbol                        |
| ----------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------- |
| offen       | Simon annotiert                                                                                  | gelb (wie heute)                             | Sprechblase                   |
| beantwortet | Server setzt automatisch bei gültiger Agent-Antwort (Referenz per `in_reply_to`)                 | grün (Simons Frage-Marke)                    | Sprechblase mit Häkchen-Punkt |
| erledigt    | Simon jederzeit per Klick auf Marke oder Bubble; Agent nur zusammen mit einer Antwort, nie still | grau (Übersteuerung: grau vor grün vor gelb) | Häkchen                       |

Beschlüsse im Detail:

1. Erledigt ist rückgängig machbar: Klick auf das graue Häkchen öffnet die Frage wieder; Farbe kehrt auf grün (beantwortet) oder gelb (offen) zurück.
2. Erledigt graut Marke, Badge und Sprechblase aus; der Textinhalt dahinter wird nur leicht entsättigt (Shift+D-Analogie erkennbar, Review-Fläche bleibt lesbar). Keine volle Done-Abdunkelung.
3. Die Navigationspfeile führen nur über offene und beantwortete Fragen; Erledigtes wird übersprungen.
4. Farben sind immer doppelt codiert (Farbe plus Form-Symbol), damit die Fläche auch bei Rot-Grün-Sehschwäche, Beamer und Ausdruck funktioniert.
5. Die Konversationsleiste bekommt einen Ausblende-Filter für Erledigtes (Schalter mit Zähler, zum Beispiel „5 erledigt ausgeblendet“); Zustand gilt pro Sitzung. Standard: erledigte Einträge sichtbar, Simon blendet bewusst aus.

## Agent-Antworten

- Farbe: blau (Marke/Sprechblase an der Stelle und Bubble in der Leiste).
- Hover über die Sprechblase zeigt die Antwort als Popup (reiner Text, kein HTML; die Overlay-Technik der Annotations-Karte wird wiederverwendet).
- Klick auf die Sprechblase springt zum zugehörigen Dialog in der Leiste; Klick auf die Leisten-Bubble springt zur Stelle.
- Agent-Antworten erscheinen direkt unter der Frage in der Leiste, mit Anker-Chip.

## Datenfluss und API

1. Der Agent erhält Annotationen weiterhin über den Poll, heute schon mit vollem Anker (Selektor, Auszug, `prompt_id`).
2. Neu: strukturiertes Feld im Poll-Body, etwa `annotation_replies: [{ in_reply_to: <prompt_id>, text, resolve: true|false }]`.
3. Der Server validiert `in_reply_to` gegen eine existierende Annotation derselben Session, speichert den Agent-Eintrag als `kind: "annotation-reply"` mit Referenz und setzt bei gültiger Antwort den Zustand beantwortet; `resolve: true` zusätzlich erledigt (nur mit Antwort).
4. Das Chrome rendert Antwort-Bubbles (blau) unter den Fragen und leitet Antworten wie Annotationen als Marks an die SDK weiter.
5. Die SDK zeichnet an der verankerten Stelle die blaue Antwort-Sprechblase, graue/grüne Markenzustände und das Hover-Popup.

## Autoritativer Annotationsbestand (Antwort auf F-1: Persistenz und Referenzprüfung)

Der Session-Chat ist ein Anzeige- und Eviction-Bestand (`src/chat-messages.js` verwirft alte Einträge und behält nur IDs; Auszüge sind auf 120 Zeichen begrenzt, vollständige Text-Targets liegen heute nur clientseitig und auf 200 Zeichen). Er ist damit nicht die Wahrheit für Referenzprüfung oder Wiederverankerung. Deshalb:

- Neuer serverseitiger Bestand `session.annotations`: Zuordnung `prompt_id` zu `{ id, kind, selector, excerpt, target (vollständiges Text-Target, serverseitig gespeichert), text, state, answers: [{ answer_id, text, at, resolve }], created_at, updated_at }`.
- Geschrieben bei Annotations-Erstellung (im selben Store-Lock wie das Prompt-Queueing), aktualisiert bei Antworten und Zustandswechseln. Der Chat bleibt reine Anzeige; der Annotationsbestand ist die einzige Quelle für Validierung, Wiederverankerung und Zustand.
- Retention: unbegrenzt pro Session (Annotationszahlen sind klein gegenüber Revisionen); keine stille Verlustgrenze. Erreicht der State eine harte Größenzone, wird ein expliziter Serverfehler gemeldet, nie still gekürzt.
- Validierung von `in_reply_to` läuft ausschließlich gegen diesen Bestand; eine verlorene Annotation wird mit einem benannten Fehler abgelehnt (404-Klasse), nie still verworfen.
- Migration des Altbestands: existierende Chat-Einträge mit `kind: "annotation"` werden beim Laden einmalig in den Bestand übernommen (Anker und Auszug wie vorhanden). Alte Text-Annotationen ohne vollständiges Target behalten den heutigen Auflösungsweg (Container-Selektor plus Excerpt); das verbleibende Restrisiko wird in `docs/invariants.md` dokumentiert. Neue Annotationen speichern das vollständige Target.

## Öffentlicher Agenten-Transport (Antwort auf F-2: CLI-Eingabe und Abschluss-Semantik)

Heute erzeugt die öffentliche CLI ausschließlich `agent_reply` (String) oder einen leeren Takeover-Body; ein reines POST mit der neuen Liste würde abgewiesen. Der Vertrag folgt der bestehenden Trennung der zwei öffentlichen Wege (`reply` für den einmaligen Abschluss, `poll` für Antworten mit weiterem Warten) und legt beide Modi eindeutig fest:

- **Modus A, Antworten und weiterwarten:** `lavish-axi poll --annotation-replies <pfad.json>` erweitert den bestehenden Long-Poll. Der POST-Body darf neu `agent_reply` (String, unverändert abwärtskompatibel), `annotation_replies` (Liste) oder beides enthalten; die Zulassungsregel des Handlers wird entsprechend erweitert. Antworten werden zu Beginn der Verarbeitung unter dem Store-Lock gespeichert, bevor irgendetwas wartet; danach läuft der Poll unverändert weiter (Feedback-Entnahme bleibt destruktiv und exklusiv, wie heute). Die Poll-Antwort erhält ein neues Feld `annotation_receipts` (Liste je Eintrag mit `accepted` oder `rejected` samt Grund, zum Beispiel `unknown_annotation`, `session_ended`, `duplicate`), ohne die bestehende Feldreihenfolge `prompts`, `artifact_failures`, `next_step`, `dom_snapshot` zu verändern; `annotation_receipts` kommt als zusätzliches Feld hinzu.
- **Modus B, einmaliger Abschluss ohne Warten:** `lavish-axi reply --annotation-replies <pfad.json>` nutzt die bestehende Reply-Route (einmaliger POST, `requireOpen`), speichert die Antworten unter dem Store-Lock und antwortet synchron mit demselben Receipt-Schema als JSON; es wird kein Feedback entnommen und nicht gewartet. Steht zum Abschlusszeitpunkt unverbrauchtes Feedback an, meldet das Receipt `feedback_pending: true` (Hinweis, dass der nächste Poll oder der Restore-Pfad es liefert); wer Feedback braucht, nutzt Modus A.
- **Verlorenes Receipt:** Beide Modi schreiben Antworten und Receipt-Teil atomar in den Annotationsbestand, bevor geantwortet oder gewartet wird. Geht die HTTP-Antwort verloren (Client-Abbruch während des Wartens in Modus A), sind die Antworten bereits persistiert; die Wiederholung mit denselben `answer_id`s wird dedupliziert und quittiert (`duplicate`), nichts geht verloren und nichts wird doppelt gespeichert.
- CLI: beide Modi drucken ihre Ausgabe als JSON auf stdout (Poll-Stdout bleibt der finalen Antwort vorbehalten; Warte-Ticks bleiben stderr-only am TTY). Die Agenten-Anleitung und CLI-Hilfe beschreiben beide Aufrufe.
- Beendete Session: Antworten nach End werden in beiden Modi abgelehnt und als `session_ended` quittiert; Poll-Übernahme und Ownership-Vertrag bleiben unverändert. Ein späteres End-to-End-Fixture prüft beide Modi einschließlich bereits wartenden Feedbacks.

## Schreib- und Sync-Vertrag für Nutzerübergänge (Antwort auf F-3: Erledigen, Rückgängig, Wiederholung)

- Neue Route `POST /api/:key/annotations/:id/state` mit Body `{ state: "done" | "open" }`, same-origin-geschützt wie `/api/:key/prompts`; Header-loser CLI-Zugriff ist für diese Nutzeraktion ausdrücklich nicht vorgesehen.
- `answered` bleibt Server-automatik (nur durch gültige Antwort); Nutzeraktionen sind ausschließlich Erledigen und Wiedereröffnen.
- Atomarität: Übergang, Persistenz im Annotationsbestand und Verteilung laufen unter `store.lock`; der Live-Strom und `chat-sync` transportieren den Annotationszustand mit (Erweiterung von `serializeChatSync` um den Bestand), sodass Reload, anderer Browser und Neustart denselben Zustand zeigen.
- Idempotenz und Wiederholung: gleicher Zustand ist ein No-Op mit Erfolgsantwort. Antworten tragen eine vom Agenten erzeugte `answer_id` (UUID); der Server dedupliziert Wiederholungen nach verlorenem Receipt anhand dieser ID.
- Konfliktregeln: mehrere Antworten sind erlaubt und bleiben zeitlich geordnet unter der Frage. `resolve: true` setzt erledigt nur aus offen oder beantwortet; nach Simons Wiedereröffnung entscheidet erneut nur Simon oder eine neue Antwort mit resolve. Ein stilles `resolve: false` auf erledigt öffnet nie wieder.

## Umsetzungsreihenfolge (Vorschlag, jeweils TDD mit roten Tests zuerst)

1. Server: autoritativer Annotationsbestand inklusive Migration, Poll-Schema (`annotation_replies`, Receipts), Nutzer-Route für Zustandsübergänge, Sync-Erweiterung, Ended-Session-Regeln.
2. Chrome: blaue Antwort-Bubbles mit Anker-Chip, Zustandsfarben, Ausblende-Filter mit Zähler.
3. SDK: Antwort-Sprechblase, Zustands-Optik (grün/grau, leichte Entsättigung), Hover-Popup, Pfeilfilter.
4. Abschluss per Team-Red-Review wie beim heutigen Paket.

## Ankerbruch über Revisionen hinweg (Risiko und Gegenmaßnahmen)

- Ursache bleibt bestehen: Überarbeitet der Agent das Artifact, entstehen neue Revisionen und Selektoren können brechen. Das Konzept verkleinert die Folgen: Erledigte Annotationen sind folgenarm verlierbar (Eintrag bleibt in der Leiste), aktive erben den Anker der Frage, werden beim Rendern neu aufgelöst und fallen bei Misslingen auf die Leisten-Darstellung zurück, ohne Inhalt zu verlieren.
- Prävention (eigenes Folgevorhaben, nicht Teil dieses Pakets): serverseitiger Revisions-Diff (welche Sektionen änderten sich zwischen zwei Versionen) als Frühwarnsystem für gefährdete Anker; Dokumentation unter `docs/todo/2026_11_09/` verlinken, sobald angelegt.
- Agenten-Anleitung ergänzen: offene Annotationen beim Überarbeiten bewusst schonen und die `prompt_id` korrekt zitieren.

## Umfangsgrenzen (bewusst nicht drin)

- Keine Prioritäten, Zuweisungen, Bearbeitungszustände oder Deadlines (kein Ticketsystem).
- Keine Antworten direkt im Artifact-HTML (keine Revisionsflut, keine HTML-Injektion in die Review-Fläche).
- Revisions-Diff als separates Vorhaben.

## Abgrenzung zu heutigem Stand

Dieses Konzept ist nicht umgesetzt. Im Working Tree liegen nur die heutigen Fixes (Shift+D-Überschrift, Element-Marks mit Pfeilnavigation, Scrollbalken, Menü-Shift-Heilung) plus der ältere copyTargetFor-Hunk (Kopier-Ausschlüsse), die als PR verschnürt werden.
