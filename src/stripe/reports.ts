import type Stripe from 'stripe';
import { getStripe } from './client.js';

/**
 * Stripe Financial Reports (Reporting API).
 * Report types used for the monthly "relevé Stripe" sent to the accountant:
 *   - balance.summary.1                      → rapport de solde
 *   - payouts.itemized.3                     → rapport des virements
 *   - balance_change_from_activity.itemized.3 → rapport des transactions / frais
 */
export const STATEMENT_REPORTS = {
  balance: 'balance.summary.1',
  payouts: 'payouts.itemized.3',
  activity: 'balance_change_from_activity.itemized.3',
} as const;

export type StatementReportKey = keyof typeof STATEMENT_REPORTS;

export const REPORT_TIMEZONE = 'Europe/Paris';

export interface ReportInterval {
  start: number; // Unix, inclusive
  end: number;   // Unix, exclusive
}

export type CsvRow = Record<string, string>;

export interface ReportResult {
  reportType: string;
  runId: string;
  fileId: string;
  csv: string;
  rows: CsvRow[];
  columns: string[];
}

/**
 * Offset (in minutes) of Europe/Paris vs UTC at a given instant.
 */
function parisOffsetMinutes(instant: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * Unix timestamp of local midnight (Europe/Paris) on the 1st of the given month.
 */
export function parisMonthStartUnix(year: number, month: number): number {
  const guess = Date.UTC(year, month - 1, 1);
  const offset = parisOffsetMinutes(new Date(guess));
  return Math.floor((guess - offset * 60000) / 1000);
}

/**
 * Report interval covering a whole calendar month in Europe/Paris time.
 */
export function monthInterval(year: number, month: number): ReportInterval {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: parisMonthStartUnix(year, month),
    end: parisMonthStartUnix(nextYear, nextMonth),
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Create a report run, wait for it to succeed, download and parse the CSV.
 */
export async function runReport(
  reportType: string,
  interval: ReportInterval,
  opts: { pollMs?: number; timeoutMs?: number; verbose?: boolean } = {},
): Promise<ReportResult> {
  const stripe = getStripe();
  const pollMs = opts.pollMs ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  let run: Stripe.Reporting.ReportRun = await stripe.reporting.reportRuns.create({
    report_type: reportType,
    parameters: {
      interval_start: interval.start,
      interval_end: interval.end,
      timezone: REPORT_TIMEZONE,
    },
  });
  if (opts.verbose) console.log(`   ${reportType}: run ${run.id} (${run.status})`);

  const startedAt = Date.now();
  while (run.status === 'pending') {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Report ${reportType} (${run.id}) still pending after ${timeoutMs / 1000}s`);
    }
    await sleep(pollMs);
    run = await stripe.reporting.reportRuns.retrieve(run.id);
  }

  if (run.status !== 'succeeded' || !run.result) {
    throw new Error(`Report ${reportType} (${run.id}) ${run.status}: ${run.error ?? 'no result'}`);
  }

  const csv = await downloadFileContents(run.result.id);
  const { columns, rows } = parseCsv(csv);
  if (opts.verbose) console.log(`   ${reportType}: ${rows.length} ligne(s)`);

  return { reportType, runId: run.id, fileId: run.result.id, csv, rows, columns };
}

/**
 * Download the contents of a Stripe File (report result) as text.
 */
export async function downloadFileContents(fileId: string): Promise<string> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');

  const res = await fetch(`https://files.stripe.com/v1/files/${fileId}/contents`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`Could not download file ${fileId}: HTTP ${res.status}`);
  }
  return res.text();
}

/**
 * Minimal RFC 4180 CSV parser (handles quoted fields, escaped quotes, CRLF).
 */
export function parseCsv(text: string): { columns: string[]; rows: CsvRow[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { record.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { record.push(field); records.push(record); record = []; field = ''; continue; }
    field += ch;
  }
  if (field.length > 0 || record.length > 0) { record.push(field); records.push(record); }

  const nonEmpty = records.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
  if (nonEmpty.length === 0) return { columns: [], rows: [] };

  const columns = nonEmpty[0];
  const rows = nonEmpty.slice(1).map(r => {
    const obj: CsvRow = {};
    columns.forEach((c, idx) => { obj[c] = r[idx] ?? ''; });
    return obj;
  });
  return { columns, rows };
}
