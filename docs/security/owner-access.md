# Mbolo TV Control — modèle d’accès propriétaire

## Décision

La console propriétaire utilise trois couches indépendantes :

1. **Zero-Trust en périphérie** : le sous-domaine privé `control.mbolotv.<domaine>` est protégé par un fournisseur d’accès (Cloudflare Access, Tailscale ou équivalent). Seule l’adresse e-mail propriétaire autorisée atteint l’application.
2. **Session applicative** : Mbolo TV vérifie une session signée stockée dans un cookie `httpOnly`, `Secure`, `SameSite=Strict` et liée à un compte portant le rôle `OWNER`.
3. **MFA** : mot de passe long + code TOTP (application d’authentification). Une validation MFA est requise à chaque nouvelle session et de nouveau avant toute action critique.

La route privée facultative `OWNER_CONSOLE_PATH` est conservée comme réduction de bruit, jamais comme contrôle d’accès. La console n’est pas placée dans la navigation publique, n’est pas indexable et ne partage ni domaine de cookie ni endpoints avec le front public plus que nécessaire.

## Parcours de connexion

```text
Navigateur → contrôle Zero-Trust → /owner/login
  → e-mail propriétaire + mot de passe
  → challenge TOTP
  → création session OWNER (15 min inactivité, 8 h absolues)
  → /control/[chemin privé]/overview
```

## Règles de sécurité

- Aucun formulaire d’inscription, d’invitation publique ou de réinitialisation automatique pour `OWNER`.
- Le premier propriétaire est créé via une commande d’exploitation unique ; l’ajout d’un autre OWNER demande une procédure manuelle et une validation MFA.
- Mot de passe : Argon2id, minimum 16 caractères, contrôle contre une liste de mots de passe compromis.
- TOTP chiffré AES-256-GCM au repos ; code de secours hachés, affichés une seule fois.
- Sessions enregistrées en base, révocables, liées au périphérique ; tous les autres appareils peuvent être déconnectés.
- Limitation forte : 5 essais par compte / 15 min, 20 par IP / heure, délai progressif et alertes.
- Toute consultation de secret source, modification/suppression de source, export et changement de sécurité exige une MFA récente (< 10 min) et écrit un audit log.
- Révocation immédiate au changement du mot de passe, de la MFA ou de l’état Zero-Trust.

## Endpoints owner prévus

| Méthode | Endpoint | Usage |
|---|---|---|
| POST | `/v1/owner/auth/login` | Vérifie e-mail/mot de passe ; crée un challenge éphémère |
| POST | `/v1/owner/auth/mfa/verify` | Vérifie TOTP, crée la session sécurisée |
| POST | `/v1/owner/auth/logout` | Révoque la session en cours |
| POST | `/v1/owner/auth/reauthenticate` | MFA récente pour action critique |
| GET | `/v1/owner/auth/sessions` | Liste les sessions propriétaire |
| DELETE | `/v1/owner/auth/sessions/:id` | Révoque une session |
| POST | `/v1/owner/sources` | Ajoute une source chiffrée |

Les routes `/v1/owner/*` sont protégées par `OwnerGuard` et `RecentMfaGuard`. Les routes publiques ne peuvent jamais accéder aux tables secrets ou aux import logs détaillés.
