export type PieceSource = 'imslp' | 'user_upload' | 'manual';

export interface Piece {
  id: string;
  title: string;
  composer?: string;
  source: PieceSource;
  imslpId?: string;
  pdfUri?: string;
  keySignature?: string;
  timeSignature?: string;
}
