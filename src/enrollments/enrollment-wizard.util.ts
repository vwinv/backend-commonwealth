import * as crypto from 'crypto';

export type EnrollmentWizardOptions = {
  scheduleId?: string;
  scheduleLabel?: string;
  authorizations?: {
    photosInternal?: boolean;
    photosCommunication?: boolean;
    outings?: boolean;
    firstAid?: boolean;
  };
  services?: string[];
  serviceSelections?: Array<{
    serviceTariffId: string;
    code: string;
    variantId?: string | null;
  }>;
  comment?: string;
};

export type EnrollmentWizardData = {
  childExtras?: {
    birthPlace?: string;
    nationality?: string;
    homeLanguages?: string;
    matricule?: string;
    childAddress?: string;
    previousSchool?: string;
    levelName?: string;
  };
  parentExtras?: {
    profession?: string;
  };
  guardian2?: {
    fullName?: string;
    relation?: string;
    phone?: string;
    email?: string;
  };
  emergency?: {
    source?: string;
    fullName?: string;
    relation?: string;
    phone?: string;
  };
  options?: EnrollmentWizardOptions;
  engagement?: {
    certified?: boolean;
    signedPlace?: string;
    signedAt?: string;
    signatureMode?: string;
    parentSignatureUrl?: string;
  };
};

export function generateResumeToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function parseWizardData(raw: unknown): EnrollmentWizardData {
  if (!raw || typeof raw !== 'object') return {};
  return raw as EnrollmentWizardData;
}

export function buildWizardData(input: {
  child?: Record<string, unknown>;
  parent?: Record<string, unknown>;
  guardian2?: Record<string, unknown>;
  emergency?: Record<string, unknown>;
  options?: Record<string, unknown>;
  engagement?: Record<string, unknown>;
}): EnrollmentWizardData {
  const str = (v: unknown) => String(v ?? '').trim();
  const data: EnrollmentWizardData = {};

  if (input.child) {
    data.childExtras = {
      birthPlace: str(input.child.birthPlace) || undefined,
      nationality: str(input.child.nationality) || undefined,
      homeLanguages: str(input.child.homeLanguages) || undefined,
      matricule: str(input.child.matricule) || undefined,
      childAddress: str(input.child.childAddress) || undefined,
      previousSchool: str(input.child.previousSchool) || undefined,
      levelName: str(input.child.levelName) || undefined,
    };
  }

  if (input.parent) {
    data.parentExtras = {
      profession: str(input.parent.profession) || undefined,
    };
  }

  if (input.guardian2) {
    const g2 = {
      fullName: str(input.guardian2.fullName),
      relation: str(input.guardian2.relation),
      phone: str(input.guardian2.phone),
      email: str(input.guardian2.email),
    };
    if (g2.fullName || g2.phone || g2.email) {
      data.guardian2 = g2;
    }
  }

  if (input.emergency) {
    data.emergency = {
      source: str(input.emergency.source) || undefined,
      fullName: str(input.emergency.fullName) || undefined,
      relation: str(input.emergency.relation) || undefined,
      phone: str(input.emergency.phone) || undefined,
    };
  }

  if (input.options) {
    const options = parseWizardOptionsInput(input.options);
    if (Object.keys(options).length) {
      data.options = options;
    }
  }

  if (input.engagement && typeof input.engagement === 'object') {
    const e = input.engagement;
    const engagement: NonNullable<EnrollmentWizardData['engagement']> = {};
    if (e.certified === true) engagement.certified = true;
    const signedPlace = str(e.signedPlace);
    if (signedPlace) engagement.signedPlace = signedPlace;
    const signedAt = str(e.signedAt);
    if (signedAt) engagement.signedAt = signedAt;
    const signatureMode = str(e.signatureMode);
    if (signatureMode) engagement.signatureMode = signatureMode;
    const parentSignatureUrl = str(e.parentSignatureUrl);
    if (parentSignatureUrl) engagement.parentSignatureUrl = parentSignatureUrl;
    if (Object.keys(engagement).length) data.engagement = engagement;
  }

  return data;
}

export function parseWizardOptionsInput(raw: Record<string, unknown>): EnrollmentWizardOptions {
  const str = (v: unknown) => String(v ?? '').trim();
  const options: EnrollmentWizardOptions = {};

  const scheduleId = str(raw.scheduleId);
  if (scheduleId) options.scheduleId = scheduleId;
  const scheduleLabel = str(raw.scheduleLabel);
  if (scheduleLabel) options.scheduleLabel = scheduleLabel;

  if (raw.authorizations && typeof raw.authorizations === 'object') {
    const auth = raw.authorizations as Record<string, unknown>;
    options.authorizations = {
      photosInternal: auth.photosInternal === true,
      photosCommunication: auth.photosCommunication === true,
      outings: auth.outings === true,
      firstAid: auth.firstAid === true,
    };
  }

  const services = Array.isArray(raw.services)
    ? raw.services.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : [];
  if (services.length) options.services = services;

  if (Array.isArray(raw.serviceSelections)) {
    const selections = raw.serviceSelections
      .map((row) => {
        const r = row as Record<string, unknown>;
        const serviceTariffId = str(r.serviceTariffId);
        const code = str(r.code).toUpperCase();
        if (!serviceTariffId || !code) return null;
        const variantIdRaw = r.variantId;
        const variantId =
          variantIdRaw === undefined || variantIdRaw === null || variantIdRaw === ''
            ? null
            : str(variantIdRaw);
        return { serviceTariffId, code, variantId };
      })
      .filter(Boolean) as EnrollmentWizardOptions['serviceSelections'];
    if (selections?.length) options.serviceSelections = selections;
  }

  const comment = str(raw.comment);
  if (comment) options.comment = comment;

  return options;
}

export function defaultWizardOptions(): EnrollmentWizardOptions {
  return {
    scheduleId: '',
    scheduleLabel: '',
    authorizations: {
      photosInternal: true,
      photosCommunication: false,
      outings: true,
      firstAid: true,
    },
    services: [],
    serviceSelections: [],
    comment: '',
  };
}
