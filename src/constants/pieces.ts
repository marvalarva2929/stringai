import type { Piece } from '../types/piece';

/**
 * Every session must name what it is, because per-piece history is what makes
 * "this got better over the week" possible at all — an unnamed take can never
 * be compared with anything.
 *
 * But scales, études, and open-string work genuinely aren't pieces, and forcing
 * a made-up title for them would scatter that work across dozens of one-session
 * "pieces" and poison the very history the requirement exists to protect. So
 * there is exactly one non-piece bucket, and it is itself a named, stable id
 * that accumulates history like any other.
 */
export const TECHNIQUE_PIECE: Piece = {
  id: 'technique-warmup',
  title: 'Technique / warm-up',
  source: 'manual',
};

export function isTechniquePiece(piece?: Piece | null): boolean {
  return piece?.id === TECHNIQUE_PIECE.id;
}
