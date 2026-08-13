# Console propriétaire — Mbolo TV Control

La gestion des fournisseurs n’est **jamais** accessible aux utilisateurs finaux. Elle est réservée au propriétaire de Mbolo TV (et, plus tard, à des opérateurs explicitement délégués).

## Accès

- Route privée configurée par variable `OWNER_CONSOLE_PATH`, par exemple `/control/5f3e2a-owner` ; elle n’est pas exposée dans la navigation ni les sitemaps.
- L’URL non devinable est une mesure de réduction de bruit, **pas** un mécanisme d’autorisation.
- Middleware serveur obligatoire : session valide + rôle `OWNER` + MFA confirmé récemment.
- Accès depuis des IP ou appareils approuvés possible en phase production.
- Cookie `httpOnly`, `secure`, `sameSite=strict`; timeout d’inactivité de 15 minutes; renouvellement de session.
- Chaque connexion, import, lecture de secret, export et suppression est écrit dans `audit_logs`.

## Capacités propriétaire

1. Ajouter, modifier, désactiver, tester et prioriser les sources M3U, Xtream et MAC.
2. Enregistrer des secrets chiffrés, sans jamais les réafficher intégralement.
3. Suivre les imports, erreurs, qualité de flux, logs sanitizés et santé des serveurs.
4. Corriger les catégories, fusions de chaînes, logos, EPG et priorités de variantes.
5. Gérer les matchs : mapping des événements, serveurs disponibles et ordre de repli.
6. Gérer les comptes utilisateurs, profils, autorisations et limites.
7. Déclencher une synchronisation, annuler un import ou désactiver immédiatement une source.

## Séparation stricte des APIs

| Zone | Audience | Exemples |
|---|---|---|
| `/v1/catalog`, `/v1/player` | Utilisateur authentifié | chaîne, EPG, jeton de lecture |
| `/v1/owner/*` | Owner + MFA seulement | sources, secrets, imports, audit |
| `/internal/*` | Worker / services internes | jobs, webhooks santé |

Aucune réponse des APIs publiques ne contient `connectionEncrypted`, URL de fournisseur, identifiant Xtream, adresse MAC ni diagnostic sensible.
