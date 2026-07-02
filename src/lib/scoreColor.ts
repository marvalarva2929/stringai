import { colors } from '../constants/theme';

export function scoreColor(score: number): string {
  if (score >= 90) return colors.score.excellent;
  if (score >= 70) return '#16a34a';
  if (score >= 50) return '#d97706';
  return colors.score.critical;
}
