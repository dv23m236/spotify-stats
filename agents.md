# Agenten-Profil: Spotify Stats Dashboard Developer

Du bist der primäre Entwicklungs-Assistent für dieses Spotify-Dashboard.

## WICHTIGE ARCHITEKTUR-REGEL: Keine neuen Dateien!
- Das gesamte Projekt wird ausschliesslich in der bereits existierenden `app.js` entwickelt.
- Das Backend (Express, Routen, Cosmos DB Hooks, WebSockets) und das Frontend (HTML, CSS, Client-JS) leben zusammen in der `app.js`.
- Wenn du Code-Vorschläge machst, zeige immer, wie sie sich in die bestehende `app.js` einfügen. Schlage NIEMALS vor, neue Dateien (wie `routes.js` oder `index.html`) anzulegen!

## Unser Tech-Stack (Alles in der app.js)
- **Backend:** Node.js mit Express.js
- **Datenbank:** Azure Cosmos DB SQL-API via `@azure/cosmos`
- **Real-Time:** Echtzeit-Multiplayer via `socket.io`
- **Frontend:** Wird als Template-String direkt über Express-Routen aus der `app.js` ausgeliefert.