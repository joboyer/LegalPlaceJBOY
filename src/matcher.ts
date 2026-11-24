import type { PoolClient } from "pg";
import { db } from "./db";
import {
  type BankLine,
  type Candidate,
  type Decision,
  type Evidence,
  type Reason,
  decide,
  withoutContested,
} from "./decision";

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

// All the pairings of a run are written by one statement.
const SAVE_PAIRINGS_SQL = `
  update transaction t
  set matched_invoice_id = p.invoice_id,
      match_evidence = p.evidence,
      matched_at = now()
  from unnest($1::uuid[], $2::uuid[], $3::text[]) as p (transaction_id, invoice_id, evidence)
  where t.id = p.transaction_id
    and t.matched_invoice_id is null`;

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

export type RunSummary = {
  /** Eligible transactions the run looked at. */
  considered: number;
  matched: Record<Evidence, number>;
  unmatched: Record<Reason, number>;
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

async function decideAll(client: PoolClient, companyId: string): Promise<Map<string, Decision>> {
  const { rows } = await client.query<CandidateRow>(CANDIDATES_SQL, [
    companyId,
    DUE_DATE_WINDOW.daysBefore,
    DUE_DATE_WINDOW.daysAfter,
  ]);

  const decisions = new Map<string, Decision>();
  for (const [transactionId, transaction] of groupByTransaction(rows)) {
    decisions.set(transactionId, decide(transaction.line, transaction.candidates));
  }
  return withoutContested(decisions);
}

async function savePairings(client: PoolClient, decisions: Map<string, Decision>): Promise<void> {
  const transactionIds: string[] = [];
  const invoiceIds: string[] = [];
  const evidences: Evidence[] = [];
  for (const [transactionId, decision] of decisions) {
    if (decision.matched) {
      transactionIds.push(transactionId);
      invoiceIds.push(decision.invoiceId);
      evidences.push(decision.evidence);
    }
  }

  const { rowCount } = await client.query(SAVE_PAIRINGS_SQL, [transactionIds, invoiceIds, evidences]);
  if (rowCount !== transactionIds.length) {
    // Someone paired one of these transactions while the run was deciding.
    throw new Error(`Expected to write ${transactionIds.length} pairings, wrote ${rowCount}`);
  }
}

function summarize(decisions: Map<string, Decision>): RunSummary {
  const summary: RunSummary = {
    considered: decisions.size,
    matched: { reference: 0, supplier: 0 },
    unmatched: { no_candidate: 0, reference_mismatch: 0, no_evidence: 0, ambiguous: 0, contested: 0 },
  };
  for (const decision of decisions.values()) {
    if (decision.matched) {
      summary.matched[decision.evidence]++;
    } else {
      summary.unmatched[decision.reason]++;
    }
  }
  return summary;
}

// The SIREN is the only value that comes from outside. A Siren can only be made by
// parseSiren, so a string that was not checked does not compile as an argument of the job.
export type Siren = string & { readonly __brand: "Siren" };

export function parseSiren(input: string): Siren {
  if (!/^\d{9}$/.test(input)) {
    throw new Error(`Not a SIREN, 9 digits expected: ${JSON.stringify(input)}`);
  }
  return input as Siren;
}

/**
 * Pairs the unmatched outgoing transactions of a company with the supplier invoices they
 * pay. The whole run is one database transaction: it writes every pairing or none.
 */
export async function runAutoMatching(companySiren: Siren): Promise<RunSummary> {
  const client = await db.connect();
  try {
    await client.query("begin");

    // The row lock makes two runs on the same company wait for each other.
    const {
      rows: [company],
    } = await client.query<{ id: string }>("select id from company where siren = $1 for update", [
      companySiren,
    ]);
    if (!company) {
      throw new Error(`No company with SIREN ${companySiren}`);
    }

    const decisions = await decideAll(client, company.id);
    await savePairings(client, decisions);

    await client.query("commit");
    return summarize(decisions);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
