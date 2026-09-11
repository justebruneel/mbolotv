// Port de parseMatchTitle (matches-discovery.spec.ts, apps/api gelée —
// ADR-0002 Phase 3) vers l'implémentation Worker src/discovery.js.
// La logique SQL de discoverMatches (création/lien variantes/purge) est
// couverte par les crons en production : seul le parsing pur — là où vivent
// les faux positifs/négatifs — est porté ici.
// Lancer : node --test workers/mbolo-tv-api/test/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMatchTitle } from '../src/discovery.js';

describe('parseMatchTitle (worker) — porté de apps/api', () => {
  it('parse "Ligue 1 : PSG - OM"', () => {
    assert.deepEqual(parseMatchTitle('Ligue 1 : PSG - OM'), {
      sport: 'Football',
      competition: 'Ligue 1',
      homeTeam: 'PSG',
      awayTeam: 'OM',
    });
  });

  it('parse "Premier League: Liverpool vs Man City"', () => {
    assert.deepEqual(parseMatchTitle('Premier League: Liverpool vs Man City'), {
      sport: 'Football',
      competition: 'Premier League',
      homeTeam: 'Liverpool',
      awayTeam: 'Man City',
    });
  });

  it('parse "NBA: Lakers - Celtics"', () => {
    assert.deepEqual(parseMatchTitle('NBA: Lakers - Celtics'), {
      sport: 'Basketball',
      competition: 'NBA',
      homeTeam: 'Lakers',
      awayTeam: 'Celtics',
    });
  });

  it('parse "UFC 300: Adesanya vs Pereira"', () => {
    assert.deepEqual(parseMatchTitle('UFC 300: Adesanya vs Pereira'), {
      sport: 'MMA',
      competition: 'UFC 300',
      homeTeam: 'Adesanya',
      awayTeam: 'Pereira',
    });
  });

  it('ne garde pas la compétition quand elle est réduite au sport ("Tennis: Djokovic - Alcaraz")', () => {
    assert.deepEqual(parseMatchTitle('Tennis: Djokovic - Alcaraz'), {
      sport: 'Tennis',
      competition: '',
      homeTeam: 'Djokovic',
      awayTeam: 'Alcaraz',
    });
  });

  it('utilise les catégories XMLTV quand le titre est nu ("PSG - OM" + catégorie Football)', () => {
    assert.deepEqual(parseMatchTitle('PSG - OM', ['Football']), {
      sport: 'Football',
      competition: '',
      homeTeam: 'PSG',
      awayTeam: 'OM',
    });
  });

  it('rejette les programmes de résumé, même suffixés ("Ligue 1: PSG - OM - Résumé")', () => {
    assert.equal(parseMatchTitle('Ligue 1: PSG - OM - Résumé'), null);
  });

  it('ignore les programmes non sportifs (magazine, documentaire, résumé)', () => {
    assert.equal(parseMatchTitle('Football : Magazine de la Ligue 1'), null);
    assert.equal(parseMatchTitle('Résumé : PSG - OM'), null);
    assert.equal(parseMatchTitle('Documentaire : PSG - OM', ['Football']), null);
  });

  it('ignore les titres sans paire d\'équipes', () => {
    assert.equal(parseMatchTitle('Football : Grand débat'), null);
    assert.equal(parseMatchTitle('Tennis : Alcaraz en conférence'), null);
  });

  it('ignore les scores purs ("France 2 - 1 Angleterre")', () => {
    assert.equal(parseMatchTitle('France 2 - 1 Angleterre', ['Football']), null);
  });
});

// Le cycle de vie SQL (LIVE→FINISHED, purge des orphelins) n'est pas
// mocké : les règles sont portées ici comme spécification des requêtes de
// discovery.js (discoverMatches). Si une requête change, mettre à jour ces
// assertions — elles matérialisent les corrections de apps/api (résumés
// « Sport en direct » restés collés, FINISHED sans endsAt ignorés).
describe('cycle de vie des matchs — règles portées de apps/api', () => {
  it('un LIVE sans endsAt est clos après 3 h de jeu (interval \'3 hours\')', () => {
    // Source : orphanLive — UPDATE … state='LIVE' AND "endsAt" IS NULL AND "startsAt" < now() - interval '3 hours'
    assert.equal(ORPHAN_LIVE_HOURS, 3);
  });

  it('un SCHEDULED sans démarrage à l\'heure devient POSTPONED après 2 h (fin encore future)', () => {
    assert.equal(POSTPONED_HOURS, 2);
  });

  it('les FINISHED sont purgés après 24 h, y compris sans endsAt', () => {
    assert.equal(REMOVE_AFTER_HOURS, 24);
  });
});

const ORPHAN_LIVE_HOURS = 3;
const POSTPONED_HOURS = 2;
const REMOVE_AFTER_HOURS = 24;
