import { db } from "./db";

// README: the due date is between 3 days before and 30 days after the transaction date.
const DUE_DATE_WINDOW = { daysBefore: 3, daysAfter: 30 };

// One row per (eligible transaction, candidate invoice). A transaction without any
// candidate still comes back once, with a null invoice.
//
// Eligible transaction: belongs to the company, outgoing, booked, not deleted, not matched.
// Candidate invoice: same company, payable (ToPay or Pending), not deleted, not already
// paid by another transaction, same amount to the cent, due date inside the window.
const CANDIDATES_SQL = `
  select t.id as transaction_id,
         t.label,
         t.date as transaction_date,
         i.id as invoice_id,
         i.supplier_name,
         i.invoice_number,
         i.due_date
  from transaction t
  join account a on a.id = t.account_id
  left join buying_invoice i
    on i.company_id = a.company_id
   and i.deleted_at is null
   and i.invoice_status in ('ToPay', 'Pending')
   and i.total_cents = -t.amount_cents
   and i.due_date between t.date - $2::int and t.date + $3::int
   and not exists (
     select 1 from transaction paid
     where paid.matched_invoice_id = i.id and paid.deleted_at is null
   )
  where a.company_id = $1::uuid
    and t.amount_cents < 0
    and t.status = 'Booked'
    and t.deleted_at is null
    and t.matched_invoice_id is null
  order by t.id, i.id`;

type CandidateRow = {
  transaction_id: string;
  label: string | null;
  transaction_date: Date;
  invoice_id: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
  due_date: Date | null;
};

type Candidate = {
  invoiceId: string;
  supplierName: string | null;
  invoiceNumber: string | null;
  dueDate: Date;
};

type PendingTransaction = {
  id: string;
  label: string | null;
  date: Date;
  candidates: Candidate[];
};

export function normalizeLabel(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

export function dayDiff(a: Date | string, b: Date | string): number {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

function scoreCandidate(transaction: PendingTransaction, candidate: Candidate): number {
  const label = normalizeLabel(transaction.label);
  let score = Math.abs(dayDiff(transaction.date, candidate.dueDate));

  if (
    label.includes(normalizeLabel(candidate.supplierName)) ||
    label.includes(normalizeLabel(candidate.invoiceNumber))
  ) {
    score -= 100;
  }

  return score;
}

function findMatch(transaction: PendingTransaction): Candidate | null {
  if (transaction.candidates.length === 0) {
    return null;
  }

  const scored = transaction.candidates.map((candidate) => ({
    candidate,
    score: scoreCandidate(transaction, candidate),
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored[0].candidate;
}

function groupByTransaction(rows: CandidateRow[]): PendingTransaction[] {
  const transactions = new Map<string, PendingTransaction>();
  for (const row of rows) {
    let transaction = transactions.get(row.transaction_id);
    if (!transaction) {
      transaction = { id: row.transaction_id, label: row.label, date: row.transaction_date, candidates: [] };
      transactions.set(row.transaction_id, transaction);
    }
    if (row.invoice_id !== null && row.due_date !== null) {
      transaction.candidates.push({
        invoiceId: row.invoice_id,
        supplierName: row.supplier_name,
        invoiceNumber: row.invoice_number,
        dueDate: row.due_date,
      });
    }
  }
  return [...transactions.values()];
}

export async function runAutoMatching(companySiren: string): Promise<void> {
  const {
    rows: [company],
  } = await db.query<{ id: string }>("select id from company where siren = $1", [companySiren]);
  if (!company) {
    throw new Error(`No company with SIREN ${companySiren}`);
  }

  const { rows } = await db.query<CandidateRow>(CANDIDATES_SQL, [
    company.id,
    DUE_DATE_WINDOW.daysBefore,
    DUE_DATE_WINDOW.daysAfter,
  ]);
  const transactions = groupByTransaction(rows);

  let matched = 0;

  for (const transaction of transactions) {
    try {
      const candidate = findMatch(transaction);
      if (!candidate) {
        continue;
      }

      await db.query(
        `update transaction set matched_invoice_id = $1::uuid
         where id = $2::uuid and matched_invoice_id is null`,
        [candidate.invoiceId, transaction.id],
      );
      matched++;
    } catch (e) {
      console.log("skip", e);
    }
  }

  console.log(`Matched ${matched} of ${transactions.length} transactions`);
}
