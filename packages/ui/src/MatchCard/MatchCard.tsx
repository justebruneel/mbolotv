import type { Match } from '@mbolo/contracts';
import { Badge, type BadgeTone } from '../Badge/Badge';
import styles from './MatchCard.module.css';

export interface MatchCardProps {
  match: Match;
}

const STATE_TONE: Record<Match['state'], BadgeTone> = {
  LIVE: 'danger',
  SCHEDULED: 'accent',
  FINISHED: 'success',
  POSTPONED: 'warning',
};

const STATE_LABEL: Record<Match['state'], string> = {
  LIVE: 'En direct',
  SCHEDULED: 'À venir',
  FINISHED: 'Terminé',
  POSTPONED: 'Reporté',
};

export function MatchCard({ match }: MatchCardProps) {
  const startsAt = new Date(match.startsAt);
  return (
    <article className={styles.card}>
      <div className={styles.top}>
        <span className={styles.competition}>{match.competition}</span>
        <Badge tone={STATE_TONE[match.state]} live={match.state === 'LIVE'}>
          {STATE_LABEL[match.state]}
        </Badge>
      </div>
      <div className={styles.teams}>
        <span className={`${styles.team} ${styles.teamA}`}>{match.homeTeam}</span>
        <span className={styles.vs}>–</span>
        <span className={`${styles.team} ${styles.teamB}`}>{match.awayTeam}</span>
      </div>
      <div className={styles.time}>
        {startsAt.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}
        {' · '}
        {startsAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
      </div>
    </article>
  );
}
