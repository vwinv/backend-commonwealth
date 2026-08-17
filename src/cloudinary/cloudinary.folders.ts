/** Dossiers Cloudinary (sous `CLOUDINARY_FOLDER`, défaut `commonwealth`). */
export const CLOUDINARY_FOLDERS = {
  landingpage: 'landingpage',
  eleve: 'eleve',
  ateliers: 'ateliers',
  documents: 'documents',
  profils: 'profils',
  signaturesSante: 'signatures/sante',
  signaturesInscriptions: 'signatures/inscriptions',
  signaturesDocuments: 'signatures/documents',
} as const;

export type CloudinaryFolder = (typeof CLOUDINARY_FOLDERS)[keyof typeof CLOUDINARY_FOLDERS];
