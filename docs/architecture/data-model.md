# Modèle de données initial

| Entité | Rôle | Champs clés |
|---|---|---|
| `users` | Compte et rôle | id, email, role, status |
| `profiles` | Préférences par foyer | user_id, name, settings |
| `sources` | Source connectée | id, owner_id, kind, name, connection_encrypted, status, priority |
| `import_runs` | Historique d’import | id, source_id, state, metrics, error_code, started_at |
| `channels` | Chaîne canonique unifiée | id, canonical_name, category_id, country, tvg_id, logo_asset_id |
| `stream_variants` | Diffusions d’une chaîne | id, channel_id, source_id, encrypted_locator, quality, health_score |
| `categories` | Taxonomie normalisée | id, name, slug, parent_id |
| `epg_programmes` | Programmes | channel_id, starts_at, ends_at, title, metadata |
| `matches` | Événements sportifs | id, sport, competition, starts_at, state |
| `match_streams` | Serveurs du match | match_id, stream_variant_id, priority, health_score |
| `favorites` | Favoris de profil | profile_id, channel_id |
| `audit_logs` | Traçabilité sécurité | actor_id, action, entity, entity_id, metadata |
