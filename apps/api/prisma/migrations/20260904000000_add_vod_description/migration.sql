-- Synopsis fournisseur sur VodItem : la source de vérité (Xtream plot) ;
-- TVmaze/TMDB ne servent qu'en secours à l'affichage.
ALTER TABLE "VodItem" ADD COLUMN "description" TEXT;
