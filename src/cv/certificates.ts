import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MasterCv } from '../config.ts';

/*
 * Your certificates: the files, kept next to your master CV in data/certificates/, and an index with
 * what each one is. The title, issuer and year are what you type, never read off the file: the Tailor
 * may put them on your CV, so they must be your own statement of what you hold.
 */

export const CERTIFICATE_TYPES = {
  pdf: { mime: 'application/pdf', ext: '.pdf' },
  png: { mime: 'image/png', ext: '.png' },
  jpg: { mime: 'image/jpeg', ext: '.jpg' },
} as const;
export type CertificateType = keyof typeof CERTIFICATE_TYPES;

export const CERTIFICATE_MAX_BYTES = 5 * 1024 * 1024;
export const CERTIFICATE_MAX_COUNT = 20;

export const CertificateSchema = z.object({
  id: z.string(),
  /** What it is, as you'd write it on a CV: "AWS Certified Developer – Associate". */
  title: z.string().min(1).max(200),
  issuer: z.string().max(200).default(''),
  /** Year obtained, e.g. "2024". */
  year: z.string().max(10).default(''),
  type: z.enum(['pdf', 'png', 'jpg']),
  /** The name of the file you uploaded, for your reference. */
  originalName: z.string(),
  size: z.number().int(),
  uploadedAt: z.string(),
});
export type Certificate = z.infer<typeof CertificateSchema>;

/** A certificate with where its file is: what the Submitter attaches. */
export type CertificateFile = Certificate & { file: string };

const IndexSchema = z.array(CertificateSchema);

const indexFile = (dir: string) => path.join(dir, 'certificates.json');
export const certificateFile = (dir: string, c: Pick<Certificate, 'id' | 'type'>) => path.join(dir, `${c.id}${CERTIFICATE_TYPES[c.type].ext}`);

/** The file's type from its first bytes, not its name: a renamed .exe stays out. */
export function sniffType(data: Buffer): CertificateType | null {
  if (data.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  return null;
}

/** Why a file can't be a certificate, or null when it can. */
export function validateCertificate(data: Buffer): string | null {
  if (data.length === 0) return 'The file is empty';
  if (data.length > CERTIFICATE_MAX_BYTES) return `The file is over ${CERTIFICATE_MAX_BYTES / 1024 / 1024} MB`;
  if (!sniffType(data)) return 'Upload a PDF, PNG or JPG file';
  return null;
}

export function listCertificates(dir: string): Certificate[] {
  if (!existsSync(indexFile(dir))) return [];
  return IndexSchema.parse(JSON.parse(readFileSync(indexFile(dir), 'utf8')));
}

/** Your certificates with their files; one whose file has gone missing is left out. */
export function certificateFiles(dir: string): CertificateFile[] {
  return listCertificates(dir)
    .map((c) => ({ ...c, file: certificateFile(dir, c) }))
    .filter((c) => existsSync(c.file));
}

function saveIndex(dir: string, list: Certificate[]) {
  mkdirSync(dir, { recursive: true });
  // Written to a temp file and renamed, so a crash mid-write never leaves a half-written index.
  const tmp = `${indexFile(dir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  renameSync(tmp, indexFile(dir));
}

export function addCertificate(
  dir: string,
  input: { data: Buffer; originalName: string; title: string; issuer?: string; year?: string },
  now = new Date(),
): Certificate {
  const problem = validateCertificate(input.data);
  if (problem) throw new Error(problem);
  const title = input.title.trim();
  if (!title) throw new Error("Give the certificate's title, as it should read on your CV");
  const year = (input.year ?? '').trim();
  if (year && !/^(19|20)\d{2}$/.test(year)) throw new Error('The year should look like 2024');
  const list = listCertificates(dir);
  if (list.length >= CERTIFICATE_MAX_COUNT) throw new Error(`You can keep up to ${CERTIFICATE_MAX_COUNT} certificates: remove one first`);
  const cert: Certificate = {
    id: `cert-${randomBytes(6).toString('hex')}`,
    title,
    issuer: (input.issuer ?? '').trim(),
    year,
    type: sniffType(input.data)!,
    originalName: path.basename(input.originalName).slice(0, 200),
    size: input.data.length,
    uploadedAt: now.toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(certificateFile(dir, cert), input.data);
  saveIndex(dir, [...list, cert]);
  return cert;
}

export function removeCertificate(dir: string, id: string): boolean {
  const list = listCertificates(dir);
  const cert = list.find((c) => c.id === id);
  if (!cert) return false;
  saveIndex(dir, list.filter((c) => c.id !== id));
  rmSync(certificateFile(dir, cert), { force: true });
  return true;
}

/** What the Tailor sees: what each certificate is, without files or upload details. */
export function certificateFacts(list: Certificate[]): NonNullable<MasterCv['certifications']> {
  return list.map((c) => ({ id: c.id, name: c.title, ...(c.issuer ? { issuer: c.issuer } : {}), ...(c.year ? { year: c.year } : {}) }));
}

/** Your CV as the Tailor reads it: the master CV plus the certificates you uploaded. */
export function withCertificates(cv: MasterCv, dir: string): MasterCv {
  const facts = certificateFacts(listCertificates(dir));
  return facts.length ? { ...cv, certifications: facts } : cv;
}
