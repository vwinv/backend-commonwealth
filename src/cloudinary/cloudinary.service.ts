import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { randomBytes } from 'crypto';
import { extname } from 'path';
import type { CloudinaryFolder } from './cloudinary.folders';

export type CloudinaryUploadResult = {
  url: string;
  publicId: string;
};

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private readonly rootFolder: string;
  private readonly ready: boolean;

  constructor(private readonly config: ConfigService) {
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME')?.trim() ?? '';
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY')?.trim() ?? '';
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET')?.trim() ?? '';
    this.rootFolder = this.config.get<string>('CLOUDINARY_FOLDER')?.trim() || 'commonwealth';
    this.ready = Boolean(cloudName && apiKey && apiSecret);

    if (this.ready) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
    } else {
      this.logger.warn(
        'Cloudinary n’est pas configuré (CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET). Les uploads échoueront.',
      );
    }
  }

  private assertReady() {
    if (!this.ready) {
      throw new ServiceUnavailableException(
        'Stockage Cloudinary non configuré. Renseignez CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY et CLOUDINARY_API_SECRET.',
      );
    }
  }

  private folderPath(folder: CloudinaryFolder) {
    return `${this.rootFolder}/${folder}`;
  }

  async uploadMulterFile(
    file: Express.Multer.File | undefined,
    folder: CloudinaryFolder,
    opts?: { resourceType?: 'image' | 'raw' | 'auto'; missingMessage?: string },
  ): Promise<CloudinaryUploadResult> {
    if (!file?.buffer?.length) {
      throw new BadRequestException(opts?.missingMessage ?? 'Fichier requis.');
    }
    return this.uploadBuffer({
      buffer: file.buffer,
      folder,
      originalName: file.originalname,
      resourceType: opts?.resourceType ?? this.guessResourceType(file),
    });
  }

  async uploadDataUrl(
    dataUrl: string,
    folder: CloudinaryFolder,
    opts?: { maxBytes?: number },
  ): Promise<CloudinaryUploadResult> {
    const parsed = parseImageDataUrl(dataUrl);
    const maxBytes = opts?.maxBytes ?? 2 * 1024 * 1024;
    if (!parsed.buffer.length || parsed.buffer.length > maxBytes) {
      throw new BadRequestException('Image trop volumineuse.');
    }
    return this.uploadBuffer({
      buffer: parsed.buffer,
      folder,
      originalName: `signature${parsed.ext}`,
      resourceType: 'image',
    });
  }

  async uploadBuffer(params: {
    buffer: Buffer;
    folder: CloudinaryFolder;
    originalName?: string;
    resourceType?: 'image' | 'raw' | 'auto';
  }): Promise<CloudinaryUploadResult> {
    this.assertReady();
    const resourceType = params.resourceType ?? 'auto';
    const folder = this.folderPath(params.folder);
    const publicId = uniquePublicId(params.originalName);

    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: publicId,
          resource_type: resourceType,
          overwrite: false,
        },
        (err, uploaded) => {
          if (err || !uploaded) {
            reject(err ?? new Error('Upload Cloudinary sans résultat.'));
            return;
          }
          resolve(uploaded);
        },
      );
      stream.end(params.buffer);
    });

    const url = result.secure_url || result.url;
    if (!url) {
      throw new ServiceUnavailableException('Cloudinary n’a pas renvoyé d’URL.');
    }
    return { url, publicId: result.public_id };
  }

  private guessResourceType(file: Express.Multer.File): 'image' | 'raw' | 'auto' {
    const mime = String(file.mimetype ?? '').toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (IMAGE_EXT.test(file.originalname)) return 'image';
    return 'raw';
  }
}

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

function uniquePublicId(originalName?: string) {
  const ext = originalName ? extname(originalName).toLowerCase() : '';
  const stem = originalName
    ? originalName
        .slice(0, Math.max(0, originalName.length - ext.length))
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
    : 'file';
  const id = `${Date.now()}-${randomBytes(6).toString('hex')}${stem ? `-${stem}` : ''}`;
  // Les fichiers raw (PDF, Word) ont besoin de l’extension dans le public_id.
  if (ext && !IMAGE_EXT.test(originalName ?? '')) {
    return `${id}${ext}`;
  }
  return id;
}

function parseImageDataUrl(dataUrl: string): { buffer: Buffer; ext: string } {
  const raw = String(dataUrl ?? '').trim();
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(raw);
  if (!match?.[2]) {
    throw new BadRequestException('Image invalide.');
  }
  const ext =
    match[1].toLowerCase() === 'webp' ? '.webp' : match[1].toLowerCase().startsWith('j') ? '.jpg' : '.png';
  return { buffer: Buffer.from(match[2], 'base64'), ext };
}
