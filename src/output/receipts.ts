import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CategorizedTransaction } from '../types.js';

/**
 * Download invoice PDFs and save receipt URLs for a set of transactions.
 */
export async function downloadReceipts(
  transactions: CategorizedTransaction[],
  outputDir: string,
  verbose: boolean,
): Promise<{ downloaded: number; failed: string[]; urlsFile: string }> {
  const receiptsDir = join(outputDir, 'receipts');
  await mkdir(receiptsDir, { recursive: true });

  let downloaded = 0;
  const failed: string[] = [];
  const receiptUrls: { id: string; date: string; amount: string; type: string; url: string }[] = [];

  for (const t of transactions) {
    // Download invoice PDF if available
    if (t.invoicePdfUrl) {
      try {
        const response = await fetch(t.invoicePdfUrl);
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          const filename = `${t.date.split('T')[0]}_${t.stripeChargeId}_invoice.pdf`;
          await writeFile(join(receiptsDir, filename), buffer);
          downloaded++;
          if (verbose) console.log(`  Downloaded: ${filename}`);
        } else {
          failed.push(`${t.stripeChargeId}: HTTP ${response.status}`);
        }
      } catch (err) {
        failed.push(`${t.stripeChargeId}: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }

    // Collect receipt URLs
    if (t.receiptUrl) {
      receiptUrls.push({
        id: t.stripeChargeId,
        date: t.date.split('T')[0],
        amount: (t.amountTTC / 100).toFixed(2) + ' EUR',
        type: t.type,
        url: t.receiptUrl,
      });
    }
  }

  // Save all receipt URLs to a file
  const urlsFile = join(outputDir, 'receipt_urls.json');
  await writeFile(urlsFile, JSON.stringify(receiptUrls, null, 2), 'utf-8');

  return { downloaded, failed, urlsFile };
}
