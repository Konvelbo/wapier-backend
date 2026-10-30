# Wapier Backend

API backend Node.js / Express pour l'application **Wapier** (Coffre de cours WhatsApp & Transcription Vocale IA).

## Fonctionnalités

- **Authentification Clerk** (Webhooks, Sessions & Tickets de connexion).
- **Intégration Baileys WhatsApp** (Pairing code sécurisé à 8 chiffres, écoute et téléchargement de documents PDF).
- **Classification IA** (Google Gemini & Groq / OpenRouter pour l'extraction de texte et le tri thématique automatique).
- **Transcription Vocale & Traduction** (Découpage karaoké et traduction instantanée en 7 langues).
- **Base de données Cloudflare D1** (Stockage et synchronisation cloud 100% sans perte).

## Déploiement Cloud (Render)

Ce dépôt est configuré pour un déploiement instantané sur [Render](https://render.com) via le fichier `render.yaml` et son `Dockerfile`.
