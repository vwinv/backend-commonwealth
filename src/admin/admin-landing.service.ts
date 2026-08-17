import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { LANDING_DEFAULT_CONTENT } from './landing-defaults';

export type LandingContent = {
  fr: Record<string, unknown>;
  en: Record<string, unknown>;
  images: Record<string, unknown>;
};

function asContent(raw: unknown): LandingContent {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    fr: (obj.fr && typeof obj.fr === 'object' ? obj.fr : {}) as Record<string, unknown>,
    en: (obj.en && typeof obj.en === 'object' ? obj.en : {}) as Record<string, unknown>,
    images: (obj.images && typeof obj.images === 'object' ? obj.images : {}) as Record<string, unknown>,
  };
}

@Injectable()
export class AdminLandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async getContent(): Promise<{ id: string; content: LandingContent; updatedAt: string }> {
    let row = await this.prisma.landingPage.findUnique({ where: { id: 'home' } });
    if (!row) {
      row = await this.prisma.landingPage.create({
        data: {
          id: 'home',
          content: LANDING_DEFAULT_CONTENT as unknown as Prisma.InputJsonValue,
        },
      });
    }
    return {
      id: row.id,
      content: asContent(row.content),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async updateContent(body: Record<string, unknown>) {
    const incoming = asContent(body.content ?? body);
    const content: LandingContent = {
      fr: incoming.fr && Object.keys(incoming.fr).length ? incoming.fr : { ...LANDING_DEFAULT_CONTENT.fr },
      en: incoming.en && Object.keys(incoming.en).length ? incoming.en : { ...LANDING_DEFAULT_CONTENT.en },
      images: incoming.images ?? {},
    };

    const previous = await this.prisma.landingPage.findUnique({ where: { id: 'home' } });
    const row = await this.prisma.landingPage.upsert({
      where: { id: 'home' },
      create: {
        id: 'home',
        content: content as unknown as Prisma.InputJsonValue,
      },
      update: {
        content: content as unknown as Prisma.InputJsonValue,
      },
    });
    await this.cloudinary.destroyUrls(
      this.cloudinary.urlsRemoved(asContent(previous?.content).images, content.images),
    );

    return {
      id: row.id,
      content: asContent(row.content),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async resetToDefaults() {
    const previous = await this.prisma.landingPage.findUnique({ where: { id: 'home' } });
    const row = await this.prisma.landingPage.upsert({
      where: { id: 'home' },
      create: {
        id: 'home',
        content: LANDING_DEFAULT_CONTENT as unknown as Prisma.InputJsonValue,
      },
      update: {
        content: LANDING_DEFAULT_CONTENT as unknown as Prisma.InputJsonValue,
      },
    });
    await this.cloudinary.destroyUrls(
      this.cloudinary.urlsRemoved(asContent(previous?.content).images, LANDING_DEFAULT_CONTENT.images),
    );
    return {
      id: row.id,
      content: asContent(row.content),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
