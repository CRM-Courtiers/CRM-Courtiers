# CRM Pro — Courtage immobilier

CRM Electron pour courtiers immobiliers québécois. Application locale, données chez le courtier (JSON), pas de cloud.

## Stack

- **Electron** (app desktop Windows + Mac)
- **Vanilla HTML/CSS/JS** (pas de framework, simple à maintenir)
- **electron-builder** + **electron-updater** (build + auto-update via GitHub Releases)

## Dev

```bash
cd electron-app
npm install
npm start
```

## Build & publish

```bash
cd electron-app
GH_TOKEN="..." npm run publish
```

## Versions

Les releases sont publiées automatiquement sur GitHub avec auto-update intégré côté client.
