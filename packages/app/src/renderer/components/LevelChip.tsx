import { levelText, type Level } from '@advpipe/contracts';

/** "Tests (3 of 5)". */
export function LevelChip({ level }: { level: Level }) {
  return <span className="chip chip-level">{levelText(level)}</span>;
}
