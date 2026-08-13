# Frontend Mbolo TV

App Router recommandé : routes publiques, application authentifiée sous `(app)`, route de lecture sous `watch/[channelId]`.

Les données serveur sont consommées via `shared/api`; les états UI locaux via `shared/stores`. Une feature ne doit pas importer directement une autre feature : elle dépend de `shared` ou de `packages/*`.
