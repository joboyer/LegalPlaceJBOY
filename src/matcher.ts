import { db } from "./db";

type TransactionRow = {
  id: string;
  amount_cents: number;
  label: string;
  date: Date;
};

type InvoiceRow = {
  id: string;
  supplier_name: string;
  invoice_number: string;
  total_cents: number;
  due_date: Date;
};

export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

export function dayDiff(a: Date | string, b: Date | string): number {
  // Both dates are local midnights. A clock change makes a day 23 or 25 hours long, so the
  // difference is rounded to the nearest day instead of floored.
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

function scoreCandidate(
  transaction: TransactionRow,
  invoice: InvoiceRow,
): number {
  const label = normalizeLabel(transaction.label);
  let score = Math.abs(dayDiff(transaction.date, invoice.due_date));

  if (
    label.includes(normalizeLabel(invoice.supplier_name)) ||
    label.includes(normalizeLabel(invoice.invoice_number))
  ) {
    score -= 100;
  }

  return score;
}

function findMatch(
  transaction: TransactionRow,
  invoices: InvoiceRow[],
): InvoiceRow | null {
  const candidates = invoices
    .filter(
      (invoice) => invoice.total_cents === Math.abs(transaction.amount_cents),
    )
    .filter((invoice) => {
      const diff = dayDiff(transaction.date, invoice.due_date);
      return diff >= -30 && diff <= 3;
    });

  if (candidates.length === 0) {
    return null;
  }

  const scored = candidates.map((invoice) => ({
    invoice,
    score: scoreCandidate(transaction, invoice),
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored[0].invoice;
}

async function getCandidates(companyId: string): Promise<InvoiceRow[]> {
  const { rows } = await db.query(
    // Without a due date the window cannot be checked, so the invoice is not a candidate.
    "select * from buying_invoice where company_id = $1::uuid and due_date is not null",
    [companyId],
  );
  return rows;
}

export async function runAutoMatching(companySiren: string): Promise<void> {
  const {
    rows: [company],
  } = await db.query("select * from company where siren = $1", [companySiren]);

  const { rows: transactions } = await db.query<TransactionRow>(
    `select transaction.*
     from transaction
     join account on account.id = transaction.account_id
     where account.company_id = $1::uuid`,
    [company.id],
  );

  let matched = 0;

  for (const transaction of transactions) {
    try {
      const invoice = findMatch(transaction, await getCandidates(company.id));
      if (!invoice) {
        continue;
      }

      await db.query(
        "update transaction set matched_invoice_id = $1::uuid where id = $2::uuid",
        [invoice.id, transaction.id],
      );
      matched++;
    } catch (e) {
      console.log("skip", e);
    }
  }

  console.log(`Matched ${matched} of ${transactions.length} transactions`);
}
