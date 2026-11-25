-- A payment whose bank reference names an invoice already paid, cancelled or deleted is
-- flagged once, for a person to review: the job never pairs it and never flags it again.
alter table transaction
  add column review_invoice_id uuid references buying_invoice (id),
  add column review_reason text check (review_reason in ('paid', 'cancelled', 'deleted', 'paired')),
  add column flagged_at timestamptz,
  add constraint transaction_review_complete check (
    (flagged_at is null) = (review_reason is null)
    and (flagged_at is null) = (review_invoice_id is null)
  );
