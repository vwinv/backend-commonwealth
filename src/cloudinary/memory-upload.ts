import { memoryStorage } from 'multer';

export const IMAGE_FILENAME = /\.(png|jpe?g|webp)$/i;
export const DOCUMENT_FILENAME = /\.(pdf|doc|docx)$/i;

export function memoryUploadOptions(opts: { maxBytes: number; filenamePattern: RegExp }) {
  return {
    storage: memoryStorage(),
    limits: { fileSize: opts.maxBytes },
    fileFilter: (
      _req: Express.Request,
      file: Express.Multer.File,
      cb: (error: Error | null, acceptFile: boolean) => void,
    ) => {
      cb(null, opts.filenamePattern.test(file.originalname));
    },
  };
}
