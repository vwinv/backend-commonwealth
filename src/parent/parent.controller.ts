import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ParentJwtGuard } from '../auth/parent-jwt.guard';
import { ParentUser } from '../auth/parent-user.decorator';
import type { ParentJwtPayload } from '../auth/parent-jwt.guard';
import { PaymentsService } from '../payments/payments.service';
import { ParentInvoicePdfService } from './parent-invoice-pdf.service';
import { ParentService } from './parent.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join } from 'path';

@Controller('parent')
@UseGuards(ParentJwtGuard)
export class ParentController {
  constructor(
    private readonly parent: ParentService,
    private readonly paymentsService: PaymentsService,
    private readonly parentInvoicePdf: ParentInvoicePdfService,
  ) {}

  @Get('me')
  me(@ParentUser() jwt: ParentJwtPayload) {
    return this.parent.getMe(jwt.sub);
  }

  @Patch('me')
  updateMe(
    @ParentUser() jwt: ParentJwtPayload,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.parent.updateMe(jwt.sub, body ?? {});
  }

  @Post('me/photo')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = join(process.cwd(), 'uploads', 'profiles');
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname) || '.bin';
          cb(null, `${Date.now()}-${randomBytes(8).toString('hex')}${ext.toLowerCase()}`);
        },
      }),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ok = /\.(png|jpe?g|webp)$/i.test(file.originalname);
        cb(null, ok);
      },
    }),
  )
  async uploadMyPhoto(
    @ParentUser() jwt: ParentJwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    if (!file) {
      throw new BadRequestException('Image requise (PNG, JPG, JPEG, WEBP).');
    }
    const publicPath = `/uploads/profiles/${file.filename}`;
    const proto = req.get('x-forwarded-proto') ?? req.protocol;
    const host = req.get('host');
    const url = host ? `${proto}://${host}${publicPath}` : publicPath;
    return this.parent.updateMePhoto(jwt.sub, url);
  }

  @Patch('me/password')
  changeMyPassword(
    @ParentUser() jwt: ParentJwtPayload,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.parent.changePassword(jwt.sub, body ?? {});
  }

  @Get('overview')
  overview(@ParentUser() jwt: ParentJwtPayload) {
    return this.parent.getOverview(jwt.sub);
  }

  @Get('notifications')
  notifications(@ParentUser() jwt: ParentJwtPayload) {
    return this.parent.listNotifications(jwt.sub);
  }

  @Patch('notifications/:id/read')
  markNotificationRead(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('id') id: string,
  ) {
    return this.parent.markNotificationRead(jwt.sub, id);
  }

  @Patch('notifications/read-all')
  markAllNotificationsRead(@ParentUser() jwt: ParentJwtPayload) {
    return this.parent.markAllNotificationsRead(jwt.sub);
  }

  @Get('payments')
  payments(@ParentUser() jwt: ParentJwtPayload) {
    return this.parent.listPaymentsOverview(jwt.sub);
  }

  @Get('invoices/tuition/:chargeId/pdf')
  async tuitionInvoicePdf(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('chargeId') chargeId: string,
  ) {
    const { buffer, filename } = await this.parentInvoicePdf.tuitionPdf(jwt.sub, chargeId);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get('invoices/monthly/:installmentId/pdf')
  async monthlyInvoicePdf(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('installmentId') installmentId: string,
  ) {
    const { buffer, filename } = await this.parentInvoicePdf.monthlyPdf(jwt.sub, installmentId);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get('invoices/legacy/:paymentId/pdf')
  async legacyInvoicePdf(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('paymentId') paymentId: string,
  ) {
    const { buffer, filename } = await this.parentInvoicePdf.legacyPdf(jwt.sub, paymentId);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get('receipts/tuition/:chargeId/pdf')
  async tuitionReceiptPdf(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('chargeId') chargeId: string,
  ) {
    const { buffer, filename } = await this.parentInvoicePdf.tuitionReceiptPdf(jwt.sub, chargeId);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get('receipts/monthly/:installmentId/pdf')
  async monthlyReceiptPdf(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('installmentId') installmentId: string,
  ) {
    const { buffer, filename } = await this.parentInvoicePdf.monthlyReceiptPdf(jwt.sub, installmentId);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get('receipts/legacy/:paymentId/pdf')
  async legacyReceiptPdf(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('paymentId') paymentId: string,
  ) {
    const { buffer, filename } = await this.parentInvoicePdf.legacyReceiptPdf(jwt.sub, paymentId);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /** Enregistre les paiements (scolarité ou mensualité) après confirmation — brancher la passerelle avant cet appel. */
  @Post('payments/complete')
  completePayments(
    @ParentUser() jwt: ParentJwtPayload,
    @Body() body: Record<string, unknown>,
  ) {
    return this.paymentsService.completeParentSchoolFees(jwt.sub, body);
  }

  @Get('documents')
  documents(@ParentUser() jwt: ParentJwtPayload) {
    return this.parent.listLevelDocuments(jwt.sub);
  }

  @Get('children/:childId')
  getChild(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('childId') childId: string,
  ) {
    return this.parent.getChildForParent(jwt.sub, childId);
  }

  @Patch('children/:childId')
  updateChild(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('childId') childId: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.parent.updateChild(jwt.sub, childId, body ?? {});
  }

  @Post('children/:childId/reenroll')
  reenrollChild(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('childId') childId: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.parent.reenrollChild(jwt.sub, childId, body ?? {});
  }

  @Get('children/:childId/space')
  childSpace(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('childId') childId: string,
  ) {
    return this.parent.getChildSpace(jwt.sub, childId);
  }

  @Post('children/:childId/health-record/sign')
  signChildHealthRecord(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('childId') childId: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.parent.signChildHealthRecord(jwt.sub, childId, body ?? {});
  }

  @Patch('children/:childId/health-record')
  updateChildHealthRecord(
    @ParentUser() jwt: ParentJwtPayload,
    @Param('childId') childId: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.parent.updateChildHealthRecord(jwt.sub, childId, body ?? {});
  }
}
