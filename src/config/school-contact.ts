import { ConfigService } from '@nestjs/config';

export const SCHOOL_CONTACT_DEFAULTS = {
  displayName: 'Commonwealth Preschool of Abidjan',
  address: '19 Rue le Perce-Neige, Riviera 6, Cocody, Abidjan',
  phone: '+225 07 11 77 77 01',
  directionEmail: 'direction@commonwealth-school.com',
  paymentModes:
    "Virement bancaire · Wave · Orange Money · Espèces (caisse de l'école)",
} as const;

export type SchoolContactConfig = {
  displayName: string;
  address: string;
  phone: string;
  directionEmail: string;
  contactEmail: string;
  administrationEmail: string;
  emergencyPhone: string;
  adminPhone: string;
  paymentModes: string;
};

export function readSchoolContact(config: ConfigService): SchoolContactConfig {
  const phone =
    config.get<string>('SCHOOL_PHONE')?.trim() ||
    config.get<string>('SCHOOL_EMERGENCY_PHONE')?.trim() ||
    config.get<string>('MAIL_EMERGENCY_PHONE')?.trim() ||
    SCHOOL_CONTACT_DEFAULTS.phone;

  const directionEmail =
    config.get<string>('SCHOOL_DIRECTION_EMAIL')?.trim() ||
    config.get<string>('SCHOOL_CONTACT_EMAIL')?.trim() ||
    config.get<string>('MAIL_ADMIN_DISPLAY_EMAIL')?.trim() ||
    config.get<string>('SCHOOL_ADMINISTRATION_EMAIL')?.trim() ||
    SCHOOL_CONTACT_DEFAULTS.directionEmail;

  return {
    displayName:
      config.get<string>('SCHOOL_DISPLAY_NAME')?.trim() || SCHOOL_CONTACT_DEFAULTS.displayName,
    address: config.get<string>('SCHOOL_ADDRESS')?.trim() || SCHOOL_CONTACT_DEFAULTS.address,
    phone,
    directionEmail,
    contactEmail: config.get<string>('SCHOOL_CONTACT_EMAIL')?.trim() || directionEmail,
    administrationEmail:
      config.get<string>('SCHOOL_ADMINISTRATION_EMAIL')?.trim() || directionEmail,
    emergencyPhone:
      config.get<string>('SCHOOL_EMERGENCY_PHONE')?.trim() ||
      config.get<string>('MAIL_EMERGENCY_PHONE')?.trim() ||
      phone,
    adminPhone: config.get<string>('MAIL_ADMIN_PHONE')?.trim() || phone,
    paymentModes:
      config.get<string>('SCHOOL_PAYMENT_MODES')?.trim() || SCHOOL_CONTACT_DEFAULTS.paymentModes,
  };
}
