import { BadRequestException } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function saveEnrollmentParentSignatureFromDataUrl(
  enrollmentId: string,
  dataUrl: string,
): string {
  const raw = String(dataUrl ?? '').trim();
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(raw);
  if (!match?.[2]) {
    throw new BadRequestException('Signature parent invalide.');
  }

  const ext =
    match[1].toLowerCase() === 'webp' ? '.webp' : match[1].toLowerCase().startsWith('j') ? '.jpg' : '.png';
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) {
    throw new BadRequestException('Signature parent trop volumineuse.');
  }

  const dir = join(process.cwd(), 'uploads', 'enrollment-signatures');
  mkdirSync(dir, { recursive: true });
  const filename = `${enrollmentId}-${Date.now()}${ext}`;
  writeFileSync(join(dir, filename), buffer);
  return `/uploads/enrollment-signatures/${filename}`;
}
