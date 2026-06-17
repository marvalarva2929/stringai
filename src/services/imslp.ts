import { Piece } from '../types/piece';

// Curated list of popular violin/string repertoire from IMSLP.
// Phase 2: replace with live IMSLP API search.
const IMSLP_CATALOG: Piece[] = [
  { id: 'imslp-canon-d', title: 'Canon in D', composer: 'Pachelbel', source: 'imslp', imslpId: 'Canon_and_Gigue_(Pachelbel,_Johann)', keySignature: 'D major', timeSignature: '4/4' },
  { id: 'imslp-four-seasons-spring', title: 'The Four Seasons — Spring', composer: 'Vivaldi', source: 'imslp', imslpId: 'The_Four_Seasons_(Vivaldi,_Antonio)', keySignature: 'E major', timeSignature: '4/4' },
  { id: 'imslp-four-seasons-summer', title: 'The Four Seasons — Summer', composer: 'Vivaldi', source: 'imslp', imslpId: 'The_Four_Seasons_(Vivaldi,_Antonio)', keySignature: 'G minor', timeSignature: '3/4' },
  { id: 'imslp-four-seasons-autumn', title: 'The Four Seasons — Autumn', composer: 'Vivaldi', source: 'imslp', imslpId: 'The_Four_Seasons_(Vivaldi,_Antonio)', keySignature: 'F major', timeSignature: '4/4' },
  { id: 'imslp-four-seasons-winter', title: 'The Four Seasons — Winter', composer: 'Vivaldi', source: 'imslp', imslpId: 'The_Four_Seasons_(Vivaldi,_Antonio)', keySignature: 'F minor', timeSignature: '4/4' },
  { id: 'imslp-czardas', title: 'Czardas', composer: 'Monti', source: 'imslp', imslpId: 'Czardas_(Monti,_Vittorio)', keySignature: 'D minor', timeSignature: '4/4' },
  { id: 'imslp-bach-chaconne', title: 'Partita No. 2 — Chaconne', composer: 'Bach', source: 'imslp', imslpId: 'Partita_for_Violin_No.2_(Bach,_Johann_Sebastian)', keySignature: 'D minor', timeSignature: '3/4' },
  { id: 'imslp-bach-air', title: 'Air on the G String', composer: 'Bach', source: 'imslp', imslpId: 'Orchestral_Suite_No.3_(Bach,_Johann_Sebastian)', keySignature: 'D major', timeSignature: '4/4' },
  { id: 'imslp-mendelssohn-concerto', title: 'Violin Concerto in E minor', composer: 'Mendelssohn', source: 'imslp', imslpId: 'Violin_Concerto_(Mendelssohn,_Felix)', keySignature: 'E minor', timeSignature: '4/4' },
  { id: 'imslp-beethoven-spring', title: 'Violin Sonata No. 5 "Spring"', composer: 'Beethoven', source: 'imslp', imslpId: 'Violin_Sonata_No.5_(Beethoven,_Ludwig_van)', keySignature: 'F major', timeSignature: '4/4' },
  { id: 'imslp-brahms-concerto', title: 'Violin Concerto in D major', composer: 'Brahms', source: 'imslp', imslpId: 'Violin_Concerto_(Brahms,_Johannes)', keySignature: 'D major', timeSignature: '3/4' },
  { id: 'imslp-tchaikovsky-concerto', title: 'Violin Concerto in D major', composer: 'Tchaikovsky', source: 'imslp', imslpId: 'Violin_Concerto_(Tchaikovsky,_Pyotr)', keySignature: 'D major', timeSignature: '4/4' },
  { id: 'imslp-paganini-24', title: 'Caprice No. 24', composer: 'Paganini', source: 'imslp', imslpId: '24_Caprices_(Paganini,_Niccolò)', keySignature: 'A minor', timeSignature: '2/4' },
  { id: 'imslp-kreisler-liebesleid', title: 'Liebesleid', composer: 'Kreisler', source: 'imslp', imslpId: 'Liebesleid_(Kreisler,_Fritz)', keySignature: 'Ab major', timeSignature: '3/4' },
  { id: 'imslp-kreisler-liebesfreud', title: 'Liebesfreud', composer: 'Kreisler', source: 'imslp', imslpId: 'Liebesfreud_(Kreisler,_Fritz)', keySignature: 'A major', timeSignature: '3/4' },
  { id: 'imslp-saint-saens-rondo', title: "Rondo Capriccioso", composer: 'Saint-Saëns', source: 'imslp', imslpId: 'Introduction_and_Rondo_Capriccioso_(Saint-Saëns,_Camille)', keySignature: 'A minor', timeSignature: '6/8' },
  { id: 'imslp-dvorak-romance', title: 'Romance in F minor', composer: 'Dvořák', source: 'imslp', imslpId: 'Romance_(Dvořák,_Antonín)', keySignature: 'F minor', timeSignature: '4/4' },
  { id: 'imslp-elgar-salut', title: "Salut d'Amour", composer: 'Elgar', source: 'imslp', imslpId: "Salut_d'Amour_(Elgar,_Edward)", keySignature: 'E major', timeSignature: '3/4' },
  { id: 'imslp-massenet-meditation', title: 'Méditation from Thaïs', composer: 'Massenet', source: 'imslp', imslpId: 'Thaïs_(Massenet,_Jules)', keySignature: 'D major', timeSignature: '4/4' },
  { id: 'imslp-tartini-devil-trill', title: "Devil's Trill Sonata", composer: 'Tartini', source: 'imslp', imslpId: 'Violin_Sonata_in_G_minor_(Tartini,_Giuseppe)', keySignature: 'G minor', timeSignature: '4/4' },
];

export function searchPieces(query: string): Piece[] {
  if (!query.trim()) return IMSLP_CATALOG.slice(0, 8);
  const q = query.toLowerCase();
  return IMSLP_CATALOG.filter(
    (p) =>
      p.title.toLowerCase().includes(q) ||
      (p.composer?.toLowerCase().includes(q) ?? false),
  );
}
