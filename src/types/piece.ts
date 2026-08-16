export type PieceSource = 'imslp' | 'user_upload' | 'manual';

export interface Piece {
  id: string;
  title: string;
  composer?: string;
  /** e.g. "I. Allegro" — narrows which piece the coach is reasoning about. */
  movement?: string;
  source: PieceSource;
  imslpId?: string;
  pdfUri?: string;
  keySignature?: string;
  timeSignature?: string;
}
