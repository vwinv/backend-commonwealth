import { BadRequestException } from '@nestjs/common';
import { Prisma, VaccinationStatus } from '@prisma/client';

export type ParsedHealthInput = {
  bloodGroup: string | null;
  doctorName: string | null;
  doctorPhone: string | null;
  knownAllergies: string | null;
  ongoingTreatments: string | null;
  dietaryRegime: string | null;
  instructions: string | null;
  vaccinations: { name: string; status: VaccinationStatus; vaccinatedAt: Date | null }[];
};

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

function parseVaccinationDate(raw: unknown): Date | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException('vaccinatedAt must be a valid date');
  }
  return d;
}

export function parsePublicHealthInput(raw: unknown): ParsedHealthInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const vaccinationsIn = body.vaccinations;
  const vaccinations = Array.isArray(vaccinationsIn)
    ? vaccinationsIn
        .map((row) => {
          const r = row as Record<string, unknown>;
          const name = String(r.name ?? '').trim();
          if (!name) return null;
          const administeredAt = String(r.vaccinatedAt ?? r.administeredAt ?? '').trim();
          const statusRaw = String(r.status ?? '').trim().toUpperCase();
          const status =
            statusRaw === VaccinationStatus.DONE || administeredAt
              ? VaccinationStatus.DONE
              : VaccinationStatus.MISSING;
          let vaccinatedAt: Date | null = null;
          if (status === VaccinationStatus.DONE && administeredAt) {
            vaccinatedAt = parseVaccinationDate(administeredAt);
          }
          return { name, status, vaccinatedAt };
        })
        .filter(Boolean) as ParsedHealthInput['vaccinations']
    : [];

  return {
    bloodGroup: str(body.bloodGroup),
    doctorName: str(body.doctorName),
    doctorPhone: str(body.doctorPhone),
    knownAllergies: str(body.knownAllergies),
    ongoingTreatments: str(body.ongoingTreatments),
    dietaryRegime: str(body.dietaryRegime),
    instructions: str(body.instructions),
    vaccinations,
  };
}

export async function upsertChildHealthRecordInTx(
  tx: Prisma.TransactionClient,
  childId: string,
  health: ParsedHealthInput,
): Promise<void> {
  const existing = await tx.childHealthRecord.findUnique({ where: { childId } });
  const record = existing
    ? await tx.childHealthRecord.update({
        where: { id: existing.id },
        data: {
          bloodGroup: health.bloodGroup,
          doctorName: health.doctorName,
          doctorPhone: health.doctorPhone,
          knownAllergies: health.knownAllergies,
          ongoingTreatments: health.ongoingTreatments,
          dietaryRegime: health.dietaryRegime,
          instructions: health.instructions,
        },
      })
    : await tx.childHealthRecord.create({
        data: {
          childId,
          bloodGroup: health.bloodGroup,
          doctorName: health.doctorName,
          doctorPhone: health.doctorPhone,
          knownAllergies: health.knownAllergies,
          ongoingTreatments: health.ongoingTreatments,
          dietaryRegime: health.dietaryRegime,
          instructions: health.instructions,
        },
      });

  await tx.childVaccination.deleteMany({ where: { healthRecordId: record.id } });
  if (health.vaccinations.length) {
    await tx.childVaccination.createMany({
      data: health.vaccinations.map((v) => ({
        healthRecordId: record.id,
        name: v.name,
        status: v.status,
        vaccinatedAt: v.vaccinatedAt,
      })),
    });
  }

  if (health.knownAllergies) {
    await tx.child.update({
      where: { id: childId },
      data: { allergies: health.knownAllergies },
    });
  }
}
