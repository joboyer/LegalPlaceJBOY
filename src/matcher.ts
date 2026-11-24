import { db } from "./db";
import { type BankLine, type Candidate, type Decision, decide, withoutContested } from "./decision";

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
         t.reference,
         i.id as invoice_id,
         i.supplier_name,
         i.invoice_number
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
  reference: string | null;
  invoice_id: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
};

type PendingTransaction = {
  line: BankLine;
  candidates: Candidate[];
};

function groupByTransaction(rows: CandidateRow[]): Map<string, PendingTransaction> {
  const transactions = new Map<string, PendingTransaction>();
  for (const row of rows) {
    let transaction = transactions.get(row.transaction_id);
    if (!transaction) {
      transaction = { line: { label: row.label, reference: row.reference }, candidates: [] };
      transactions.set(row.transaction_id, transaction);
    }
    if (row.invoice_id !== null) {
      transaction.candidates.push({
        invoiceId: row.invoice_id,
        supplierName: row.supplier_name,
        invoiceNumber: row.invoice_number,
      });
    }
  }
  return transactions;
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

  const decisions = new Map<string, Decision>();
  for (const [transactionId, transaction] of groupByTransaction(rows)) {
    decisions.set(transactionId, decide(transaction.line, transaction.candidates));
  }

  let matched = 0;

  for (const [transactionId, decision] of withoutContested(decisions)) {
    if (!decision.matched) {
      continue;
    }
    try {
      await db.query(
        `update transaction set matched_invoice_id = $1::uuid
         where id = $2::uuid and matched_invoice_id is null`,
        [decision.invoiceId, transactionId],
      );
      matched++;
    } catch (e) {
      console.log("skip", e);
    }
  }

  console.log(`Matched ${matched} of ${decisions.size} transactions`);
}
