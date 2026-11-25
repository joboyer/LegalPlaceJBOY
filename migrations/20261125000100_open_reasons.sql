-- Every run writes why a transaction is still open, and for a lone candidate with no link the
-- invoice to suggest, so a person can confirm it in one click. Cleared once it is paired.
alter table transaction
  add column open_reason text check (
    open_reason in ('no_candidate', 'reference_mismatch', 'no_evidence', 'ambiguous', 'contested')
  ),
  add column suggested_invoice_id uuid references buying_invoice (id),
  add column checked_at timestamptz;
