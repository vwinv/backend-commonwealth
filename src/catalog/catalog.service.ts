import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SchoolYearStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  listLevels() {
    return this.prisma.level.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: { classes: true, documents: { include: { document: true } } },
    });
  }

  async activeSchoolYear() {
    const row = await this.prisma.schoolYear.findFirst({
      where: { status: SchoolYearStatus.OPEN },
      orderBy: { startDate: 'desc' },
      select: { label: true, startDate: true, endDate: true },
    });
    return { active: row };
  }

  async createLevel(input: any) {
    const name = String(input?.name ?? '').trim();
    if (!name) throw new BadRequestException('name is required');
    const order = input?.order === undefined || input?.order === null ? undefined : Number(input.order);
    if (order !== undefined && !Number.isInteger(order)) throw new BadRequestException('order must be an integer');

    try {
      return await this.prisma.level.create({ data: { name, order } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Level name already exists');
      }
      throw e;
    }
  }

  async listClasses(levelId: string) {
    const level = await this.prisma.level.findUnique({ where: { id: levelId }, select: { id: true } });
    if (!level) throw new NotFoundException('Level not found');
    return this.prisma.classRoom.findMany({
      where: { levelId },
      orderBy: [{ name: 'asc' }],
    });
  }

  async createClass(input: any) {
    const levelId = String(input?.levelId ?? '').trim();
    const name = String(input?.name ?? '').trim();
    if (!levelId) throw new BadRequestException('levelId is required');
    if (!name) throw new BadRequestException('name is required');

    try {
      return await this.prisma.classRoom.create({ data: { levelId, name } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new NotFoundException('Level not found');
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Class already exists for this level');
      }
      throw e;
    }
  }

  async createDocument(input: any) {
    const title = String(input?.title ?? '').trim();
    const url = String(input?.url ?? '').trim();
    if (!title) throw new BadRequestException('title is required');
    if (!url) throw new BadRequestException('url is required');

    return this.prisma.document.create({ data: { title, url } });
  }

  async attachDocument(levelId: string, documentId: string) {
    try {
      return await this.prisma.levelDocument.create({
        data: { levelId, documentId },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new NotFoundException('Level or Document not found');
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Document already attached to this level');
      }
      throw e;
    }
  }
}

