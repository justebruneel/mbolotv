# Route Mbolo TV Control

Cette route est un emplacement d’architecture, pas une protection en soi.

Le middleware doit vérifier :

1. correspondance avec `OWNER_CONSOLE_PATH` ;
2. utilisateur authentifié ;
3. rôle `OWNER` ;
4. MFA réussie depuis moins de 10 minutes ;
5. contrôle éventuel d’appareil/IP.

La page contient les sous-vues : `overview`, `sources`, `imports`, `catalog`, `matches`, `users`, `audit` et `settings`.
