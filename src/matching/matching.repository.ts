import type { PoolClient } from "pg";
import type { Evidence, Reason, TransactionToMatch, Unpayable } from "./decision";
import type { Siren } from "./siren";

// Every query of the matching job. Each function runs on the client of the caller, inside its
// database transaction, and maps rows to the types of the domain.

// One row per (eligible transaction, candidate invoice). A transaction without any
// candidate still comes back once, with a null invoice.
//
// Eligible transaction: belongs to the company, outgoing, booked, not deleted, not matched,
// not flagged for review.
// Candidate invoice: same company, same amount to the cent, due date inside the window.
// `unpayable` says why a candidate cannot be paired: only invoices where it is null
// (ToPay or Pending, not deleted, not paid by another transaction) can be.
const CANDIDATES_SQL = `
  select t.id as transaction_id,
         t.label,
         t.reference,
         i.id as invoice_id,
         i.supplier_name,
         i.invoice_number,
         case
           when i.id is null then null
           when i.deleted_at is not null then 'deleted'
           when i.invoice_status = 'Cancelled' then 'cancelled'
           when i.invoice_status not in ('ToPay', 'Pending') then 'paid'
           when exists (
             select 1 from transaction paid
             where paid.matched_invoice_id = i.id and paid.deleted_at is null
           ) then 'paired'
         end as unpayable
  from transaction t
  join account a on a.id = t.account_id
  left join buying_invoice i
    on i.company_id = a.company_id
   and i.total_cents = -t.amount_cents
   and i.due_date between t.date - $2::int and t.date + $3::int
  where a.company_id = $1::uuid
    and t.amount_cents < 0
    and t.status = 'Booked'
    and t.deleted_at is null
    and t.matched_invoice_id is null
    and t.flagged_at is null
  order by t.id, i.id`;

type CandidateRow = {
  transaction_id: string;
  label: string | null;
  reference: string | null;
  invoice_id: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
  unpayable: Unpayable | null;
};

/** Locks the company row, so two runs on the same company wait for each other. */
export async function lockCompany(client: PoolClient, siren: Siren): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    "select id from company where siren = $1 for update",
    [siren],
  );
  return rows[0]?.id ?? null;
}

/** The eligible transactions of a company, each with its candidate invoices. */
export async function findTransactionsToMatch(
  client: PoolClient,
  companyId: string,
  window: { daysBefore: number; daysAfter: number },
): Promise<Map<string, TransactionToMatch>> {
  const { rows } = await client.query<CandidateRow>(CANDIDATES_SQL, [
    companyId,
    window.daysBefore,
    window.daysAfter,
  ]);

  const transactions = new Map<string, TransactionToMatch>();
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
        unpayable: row.unpayable,
      });
    }
  }
  return transactions;
}

export type Pairing = { transactionId: string; invoiceId: string; evidence: Evidence };
export type Flag = { transactionId: string; invoiceId: string; invoice: Unpayable };
export type OpenState = {
  transactionId: string;
  reason: Reason;
  suggestedInvoiceId: string | null;
};

// All the pairings of a run are written by one statement.
const SAVE_PAIRINGS_SQL = `
  update transaction t
  set matched_invoice_id = p.invoice_id,
      match_evidence = p.evidence,
      matched_at = now(),
      open_reason = null,
      suggested_invoice_id = null
  from unnest($1::uuid[], $2::uuid[], $3::text[]) as p (transaction_id, invoice_id, evidence)
  where t.id = p.transaction_id
    and t.matched_invoice_id is null`;

export async function savePairings(client: PoolClient, pairings: Pairing[]): Promise<void> {
  const { rowCount } = await client.query(SAVE_PAIRINGS_SQL, [
    pairings.map((pairing) => pairing.transactionId),
    pairings.map((pairing) => pairing.invoiceId),
    pairings.map((pairing) => pairing.evidence),
  ]);
  if (rowCount !== pairings.length) {
    // Someone paired one of these transactions while the run was deciding.
    throw new Error(`Expected to write ${pairings.length} pairings, wrote ${rowCount}`);
  }
}

// Flags are written once: a flagged transaction is no longer eligible, so no later run
// reports it again until a person clears the flag or pairs it by hand.
const SAVE_FLAGS_SQL = `
  update transaction t
  set review_invoice_id = f.invoice_id,
      review_reason = f.reason,
      flagged_at = now(),
      open_reason = null,
      suggested_invoice_id = null
  from unnest($1::uuid[], $2::uuid[], $3::text[]) as f (transaction_id, invoice_id, reason)
  where t.id = f.transaction_id
    and t.flagged_at is null
    and t.matched_invoice_id is null`;

export async function saveFlags(client: PoolClient, flags: Flag[]): Promise<void> {
  const { rowCount } = await client.query(SAVE_FLAGS_SQL, [
    flags.map((flag) => flag.transactionId),
    flags.map((flag) => flag.invoiceId),
    flags.map((flag) => flag.invoice),
  ]);
  if (rowCount !== flags.length) {
    throw new Error(`Expected to write ${flags.length} flags, wrote ${rowCount}`);
  }
}

// The transactions left open get their reason and suggestion again on every run, since a new
// invoice may change both.
const SAVE_OPEN_STATES_SQL = `
  update transaction t
  set open_reason = o.reason,
      suggested_invoice_id = o.suggested_invoice_id,
      checked_at = now()
  from unnest($1::uuid[], $2::text[], $3::uuid[])
       as o (transaction_id, reason, suggested_invoice_id)
  where t.id = o.transaction_id
    and t.matched_invoice_id is null
    and t.flagged_at is null`;

export async function saveOpenStates(client: PoolClient, states: OpenState[]): Promise<void> {
  await client.query(SAVE_OPEN_STATES_SQL, [
    states.map((state) => state.transactionId),
    states.map((state) => state.reason),
    states.map((state) => state.suggestedInvoiceId),
  ]);
}
