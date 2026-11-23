# Findings

Baseline: on the seed, for company `900997767`, the job reports `Matched 508 of 1200
transactions`. The numbers below come from that run, or from the same logic replayed with
counters (process in `Europe/Paris`).

Ranking rule: the README says a wrong pairing is worse than no pairing. So first what writes
wrong pairings on a normal run (1 to 6), then what loses pairings or hides failures (7, 8),
then what needs an attacker, a race or more data to hurt (9 to 11), then maintainability (12).

1. **It never abstains.** `findMatch` returns the best-scored candidate, whatever the score.
   192 transactions have several candidates (up to 22). 35 are exact ties, decided by the row
   order of an unordered `select *`. Amount and date alone are weak evidence: with exact
   amounts, of 60 single-candidate transactions that carry an invoice number in `reference`,
   9 name another invoice.
2. **It matches invoices that cannot be paid.** Candidates are filtered on `company_id` only.
   29 pairings point to a cancelled invoice, 12 to a soft-deleted one, 150 to one already
   marked as paid.
3. **One invoice can be paid several times.** 26 transactions share 13 invoices in one run,
   including a bank line imported twice. Already-matched transactions are processed again,
   so a manual pairing can be overwritten.
4. **It matches transactions it should not look at.** `Math.abs` hides the sign: 8 incoming
   payments are paired with supplier invoices, and 5 soft-deleted transactions too. 23
   pending ones as well, which is a product question rather than a bug.
5. **The label bonus is wrong both ways.** An empty `invoice_number` matches every label
   (`PRLV SEPA SAGE` goes to Qonto). Substrings cross names (`SFRI SARL` goes to SFR). A
   legal suffix hides a real match (`sage sas` is not in `prlv sepa sage`).
6. **The result depends on the server time zone.** `dayDiff` mixes local midnight (`date`)
   and UTC midnight (`varchar`). In Paris the window is shifted by one day. Replayed in UTC,
   57 results change.
7. **Amounts are floats compared with `===`.** `512.83 + 102.57 !== 615.4`. 115 transactions
   find no candidate although an invoice matches to the cent.
8. **Errors are swallowed.** A `NULL` supplier name throws, the `catch` logs `skip`, the
   transaction is dropped and the job exits 0. A partial failure looks like a normal run.
   Same silence for the 1,051 invoices without a due date.
9. **SQL injection.** Queries are concatenated: `runAutoMatching("' or ''='")` runs the job
   on the first company of the table. Not ranked higher only because the SIREN is a constant
   today.
10. **No transaction, no lock, no trace.** Two overlapping runs can pair the same invoice
    twice. Nothing records when or why a pairing was made, so a bad run can be neither
    explained nor reverted.
11. **One query per transaction.** All 35,017 invoices are reloaded for each of the 1,200
    transactions: 42 million rows for one company.
12. **Nothing guards the future.** No foreign key (the seed has a transaction on a missing
    account), no unique or `NOT NULL` constraint, no index. Two tests, none on a matching
    decision. A missing company ends in a `TypeError`.
