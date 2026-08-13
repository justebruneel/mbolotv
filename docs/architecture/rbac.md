# RBAC Mbolo TV

| Rôle | Catalogue / lecture | Gestion de sources | Utilisateurs | Audit / secrets |
|---|---:|---:|---:|---:|
| `USER` | Oui, périmètre autorisé | Non | Son profil | Non |
| `SUPPORT` | Lecture limitée | Non | Assistance limitée | Non |
| `ADMIN` | Oui | Non par défaut | Oui | Audit partiel |
| `OWNER` | Oui | Oui | Oui | Oui, actions tracées |

Le rôle `OWNER` ne peut être créé par inscription. Il est provisionné manuellement via migration sécurisée ou procédure d’exploitation. Les routes owner vérifient également une affirmation MFA récente.
