# TRI-ANGLE — Courtage immobilier

CRM Electron pour courtiers immobiliers québécois. Application locale, données chez le courtier (JSON), pas de cloud pour les données clients (synchronisation via Dropbox/OneDrive optionnelle).

**Domaine** : [tri-angle.ca](https://tri-angle.ca)
**Contact** : contact@tri-angle.ca

## Stack

- **Electron** (app desktop Windows + Mac)
- **Vanilla HTML/CSS/JS** (pas de framework, simple à maintenir)
- **electron-builder** + **electron-updater** (build + auto-update via GitHub Releases)
- **Google Calendar API** (OAuth desktop, sync optionnelle)
- **License server** : Vercel + Upstash Redis KV + Resend (transactional email)

## Dev

```bash
cd electron-app
npm install
npm start
```

## Build & publish

```powershell
$env:GH_TOKEN = [System.Environment]::GetEnvironmentVariable("GH_TOKEN", "User")
cd electron-app
npm run publish
```

## Versions

Les releases sont publiées automatiquement sur GitHub avec auto-update intégré côté client.

## Note historique

Le dossier est nommé `CRM Pro` (et le HTML principal `crm-pro.html`) pour des raisons de compatibilité technique avec les chemins existants. Le nom commercial actuel du produit est **TRI-ANGLE**.
