# Module `owner-auth`

Ce module est distinct de l’authentification utilisateur afin d’isoler les règles d’accès à Mbolo TV Control.

À implémenter :

- `OwnerAuthController` : login, challenge TOTP, logout, sessions, re-authentication.
- `OwnerPasswordService` : Argon2id + vérification contre mots de passe compromis.
- `TotpService` : génération, chiffrement, vérification avec tolérance d’une fenêtre.
- `OwnerSessionService` : session opaque, hash du token, expiration, révocation et rotation.
- `OwnerGuard` : rôle OWNER, session valide, contrôle Zero-Trust déjà transmis par proxy.
- `RecentMfaGuard` : oblige une MFA de moins de 10 minutes pour les actions sensibles.

Ne jamais accepter le rôle ou l’état MFA depuis un cookie lisible côté client. La session opaque est vérifiée côté serveur et son hash est comparé à PostgreSQL/Redis.
