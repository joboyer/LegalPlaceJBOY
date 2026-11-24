-- Amounts become integer cents: exact in Postgres and in JavaScript. The sign is kept
-- (negative = money out). The cast goes through float8 on purpose: real::numeric keeps only
-- 6 significant digits, so 12345.67 would become 12345.70.
alter table transaction add column amount_cents bigint;
update transaction set amount_cents = round(amount::float8::numeric * 100);
alter table transaction
  alter column amount_cents set not null,
  drop column amount;

alter table buying_invoice
  add column tax_free_total_cents bigint,
  add column vat_amount_cents bigint;
update buying_invoice set
  tax_free_total_cents = round(tax_free_total::float8::numeric * 100),
  vat_amount_cents = round(vat_amount::float8::numeric * 100);
alter table buying_invoice
  alter column tax_free_total_cents set not null,
  alter column vat_amount_cents set not null,
  drop column tax_free_total,
  drop column vat_amount;
alter table buying_invoice
  add column total_cents bigint generated always as (tax_free_total_cents + vat_amount_cents) stored;

-- A due date is a date. A value that is not one now fails here, instead of being ignored
-- silently by the job.
alter table buying_invoice
  alter column due_date type date using nullif(trim(due_date), '')::date;

-- What the job relies on is now enforced by the database.
alter table company add constraint company_siren_key unique (siren);
alter table account
  add constraint account_company_fk foreign key (company_id) references company (id);
alter table buying_invoice
  add constraint buying_invoice_company_fk foreign key (company_id) references company (id);
alter table transaction
  add constraint transaction_matched_invoice_fk foreign key (matched_invoice_id) references buying_invoice (id);
-- The seed holds a transaction on an account that does not exist, so existing rows cannot
-- be validated. NOT VALID still checks every new row.
alter table transaction
  add constraint transaction_account_fk foreign key (account_id) references account (id) not valid;

-- Without these values a row belongs to no company or can never be matched, and the job
-- skips it without a word. None is missing in the seed. Production data has to be checked
-- first: one missing value and this migration fails.
alter table company alter column siren set not null;
alter table account alter column company_id set not null;
alter table buying_invoice
  alter column company_id set not null,
  alter column invoice_status set not null;
alter table transaction
  alter column account_id set not null,
  alter column date set not null,
  alter column status set not null;

-- An invoice is paid by at most one live transaction, whoever writes the pairing.
create unique index transaction_matched_invoice_key on transaction (matched_invoice_id)
  where matched_invoice_id is not null and deleted_at is null;

-- When and on what evidence the job made a pairing. NULL means it did not come from the job.
alter table transaction
  add column matched_at timestamptz,
  add column match_evidence text;

-- The two lookups of the job.
create index account_company_idx on account (company_id);
create index transaction_unmatched_idx on transaction (account_id)
  where matched_invoice_id is null and deleted_at is null;
create index buying_invoice_candidates_idx on buying_invoice (company_id, total_cents, due_date)
  where deleted_at is null;
