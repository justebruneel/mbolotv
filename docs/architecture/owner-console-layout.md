# Organisation de Mbolo TV Control

## Navigation propriétaire

- **Vue système** : santé globale, jobs en attente, incidents, dernière synchronisation.
- **Sources** : M3U / Xtream / MAC, test sécurisé, priorité, statut, action d’arrêt immédiat.
- **Imports** : progression par étape, historique, erreurs sans secrets, relance contrôlée.
- **Catalogue unifié** : chaînes, catégories, règles de fusion, variantes et qualité.
- **EPG & Matchs** : associations programme/chaîne, matchs en direct, ordre des serveurs.
- **Utilisateurs** : comptes, profils, accès et suspension.
- **Audit** : export filtrable des actions sensibles.
- **Réglages** : politiques de rétention, clés, alertes et intégrations.

## Comportements UX essentiels

- Écran source : état temps réel, nombre de chaînes créées/mises à jour/ignorées et dernière erreur actionnable.
- Les valeurs sensibles sont masquées par défaut ; aucune action « afficher » sans réauthentification MFA.
- Suppression en deux temps : désactivation immédiate, purge différée et confirmée.
- Chaque bouton dangereux affiche l’impact : chaînes, variantes, favoris et matchs concernés.
- Les actions longues créent un job observable au lieu de bloquer l’interface.
