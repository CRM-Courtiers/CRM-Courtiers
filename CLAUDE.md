# TRI-ANGLE — Projet (Briefing pour Claude)

## 🚨 NOMS DU PROJET

**Nom officiel actuel** : **TRI-ANGLE**

Anciens noms historiques (encore présents dans paths/packages/données pour compatibilité technique) :
- CRM Sophie (avril 2026) — version originale
- CRM Pro (mai 2026) — refonte commerciale

Si l'utilisateur dit "on continue TRI-ANGLE", "on continue CRM Pro" OU "on continue le CRM" → **C'EST LE MÊME PROJET**. Lis ce fichier et `.claude/memory/project_crmpro_resume_demain.md`.

## Identité
- **Nom commercial** : TRI-ANGLE
- **Slogan** : "La pierre angulaire de votre réussite"
- **Domaine** : `tri-angle.ca` (Cloudflare Registrar)
- **Email** : `contact@tri-angle.ca` (Cloudflare Email Routing → Gmail)
- **Produit** : CRM Electron pour courtiers immobiliers québécois
- **Pricing** : 90 jours essai gratuit, puis 80$/mois ou 600$/an (Interac autodépôt à `lpbussiere.lpb@gmail.com`)
- **Cible** : ~14 000 courtiers QC, alternative simple à AVA Client (300$/mois)
- **User** : Louis-Paul Bussière (GitHub `lpbussiere`), construit l'app pour sa blonde Sophie Morissette (courtière)

## ⚠ Mémoire détaillée à charger AU DÉMARRAGE
Lis ces fichiers en premier — ils contiennent l'état complet du projet :
- **`.claude/memory/project_crmpro_resume_demain.md`** ← **LIRE EN PRIORITÉ**, état complet à jour
- `.claude/memory/project_crmpro_roadmap.md` — état des étapes (historique)
- `.claude/memory/project_crmpro_autoupdate_plan.md` — auto-update + serveur licences (historique)
- `.claude/memory/project_crmpro_design.md` — palette + décisions UI
- `.claude/memory/project_crmpro_design_inspirations.md` — refs visuelles Pluralsight

## État actuel (en bref, 2026-05-12 fin pm)
- **v0.1.29 publié** sur GitHub Releases — auto-update fonctionnel
- **Licences KV Upstash Redis** : serveur Vercel `https://license-server-ebon-xi.vercel.app`
- **Dashboard admin web** `/admin` — basic auth, gestion complète des clés
- **Trial signup self-service 90 jours** avec courriel de bienvenue Resend (`contact@tri-angle.ca`)
- **Modal renouvellement licence** avec instructions Interac
- **Google Calendar OAuth** intégré (status "In Production", warning "App non vérifiée" reste)
- **Vue Calendrier mois** + **Dashboard analytique** (résumé mois + résumé annuel + funnel)
- **Wizard onboarding 3 étapes** : Trial → Dossier → Google Calendar (recommandé)
- **Prochaine étape** : build Mac .dmg pour Sophie (quand son Mac arrive)

## Workflow publish (à utiliser à chaque release)
```powershell
$env:GH_TOKEN = [System.Environment]::GetEnvironmentVariable("GH_TOKEN", "User")
cd "C:\Users\Client\Dropbox (Compte personnel)\CRM Pro\electron-app"
& npm.cmd run publish
```
**Ne JAMAIS** demander au user de coller son token dans le chat — utiliser cette commande PowerShell qui lit l'env var Windows USER permanente.

Si build foire sur `dist\win-unpacked\locales` verrouillé :
```powershell
Get-Process -Name 'TRI-ANGLE' -ErrorAction SilentlyContinue | Stop-Process -Force
rm -r "C:\Users\Client\Dropbox (Compte personnel)\CRM Pro\electron-app\dist"
```
puis retry.

## Workflow génération clé licence (CLI scripts KV)
```powershell
cd "C:\Users\Client\Dropbox (Compte personnel)\CRM Pro\license-server"
node list-keys.js                                    # voir toutes
node generate-key.js "Nom Client" trial 3            # créer
node renew-key.js "ABCD-EFGH-IJKL-MNOP" 12           # +12 mois
node revoke-key.js "ABCD-EFGH-IJKL-MNOP"             # soft revoke
```
Plus besoin de `npm run deploy` après mutation — KV est live.

Vercel CLI auth via `lpbussiere`, team `tri-angle`.

## Palette de couleurs (à respecter pour toute nouvelle UI)
- **Slate primary** : `#0F172A` (header, sidebar, hero) / `#1E293B` / `#475569`
- **Light bg** : `#F8FAFC` (main content area)
- **Cyan** `#06B6D4` : Prospects + En relance INACTIVE
- **Red** `#EF4444` (top) / `#DC2626` (bg) : P.A. Active + En relance ACTIVE
- **Lime** `#84CC16` : En Vente
- **Amber** `#F59E0B` : Conclues
- **Sky** `#0EA5E9` : Accueil + CTAs
- **Mauve/Purple** `#A855F7` : Pancartes
- **Slate-500** `#64748B` : Archives + Système (neutre)

## Localisation des fichiers
- **Code app** : `crm-pro.html` (nom historique gardé pour compat), `electron-app/main.js`, `electron-app/preload.js`, `electron-app/google-calendar.js`
- **Logos** : `triangle-logo-full.png`, `triangle-logo-light.png`, `electron-app/build/icon.png`
- **License server** : `license-server/api/*.js`, `license-server/data/keys.json` (seed), `license-server/lib/kv.js`
- **GitHub repo** : https://github.com/CRM-Courtiers/CRM-Courtiers (org `CRM-Courtiers` — nom historique)

## Préférences user
- Réponses courtes et structurées (pas de pavés)
- Communication en français
- Toujours poser questions si options multiples ou doute
- Tests sur PC Windows, déploiement final Mac aussi (Sophie)
- Pas de `prompt()` JS (Electron bloque) → modals customs
- Le user travaille sur plusieurs jours, doit pouvoir reprendre où on était

## Sauvegarde de mémoire (double localisation)
1. **Source de vérité** : `~/.claude/projects/C--CRM-Sophie/memory/` (système Claude Code — le nom "C--CRM-Sophie" est l'encodage automatique du path initial `C:\CRM Sophie`, pas une référence au dossier physique)
2. **Backup Dropbox** : `.claude/memory/` (ce dossier) — synchronisé via Dropbox, survit aux reformatages

Si tu modifies un fichier mémoire, mets à jour les DEUX endroits pour rester en sync.

## Onglets/IDs internes du HTML (référence)
- `cp` = Clients potentiels, `vp` = Vendeurs potentiels, `a` = Acheteurs
- `pa` = P.A. Active, `v` = En Vente
- `ac` = Acheteurs conclus, `vc` = Vendeurs conclus
- `ca` = Contacts autre, `settings` = Paramètres, `pancartes` = Pancartes
- `accueil` = Accueil, `calendar` = Calendrier, `dashboard` = Tableau de bord
- ❌ `ra`/`rv` (Refus) ont été **supprimés** entièrement
