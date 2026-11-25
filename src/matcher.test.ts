import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { type Siren, parseSiren, runAutoMatching } from "./matcher";

// These tests run the real job against Postgres. Each one states a rule with the smallest
// data that shows it: by default, one invoice of 120.00 from Acme due on the day of a
// 120.00 payment labelled "PRLV SEPA ACME".

const SIREN = parseSiren("111111111");
let companyId: string;
let accountId: string;

async function givenCompany(siren: string) {
  const company = randomUUID();
  const account = randomUUID();
  await db.query("insert into company (id, siren, name) values ($1, $2, $2)", [company, siren]);
  await db.query("insert into account (id, company_id, iban) values ($1, $2, 'FR76')", [
    account,
    company,
  ]);
  return { companyId: company, accountId: account };
}

async function givenInvoice(overrides: Record<string, unknown> = {}): Promise<string> {
  const invoice = {
    id: randomUUID(),
    companyId,
    supplier: "Acme",
    number: "INV-1",
    taxFreeCents: 10000,
    vatCents: 2000,
    dueDate: "2026-03-10",
    status: "ToPay",
    deletedAt: null,
    ...overrides,
  };
  await db.query(
    `insert into buying_invoice
       (id, company_id, supplier_name, invoice_number, tax_free_total_cents, vat_amount_cents,
        due_date, invoice_status, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      invoice.id,
      invoice.companyId,
      invoice.supplier,
      invoice.number,
      invoice.taxFreeCents,
      invoice.vatCents,
      invoice.dueDate,
      invoice.status,
      invoice.deletedAt,
    ],
  );
  return invoice.id;
}

async function givenTransaction(overrides: Record<string, unknown> = {}): Promise<string> {
  const transaction = {
    id: randomUUID(),
    accountId,
    amountCents: -12000,
    date: "2026-03-10",
    label: "PRLV SEPA ACME",
    reference: "",
    status: "Booked",
    deletedAt: null,
    matchedInvoiceId: null,
    ...overrides,
  };
  await db.query(
    `insert into transaction
       (id, account_id, amount_cents, date, label, reference, status, deleted_at,
        matched_invoice_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      transaction.id,
      transaction.accountId,
      transaction.amountCents,
      transaction.date,
      transaction.label,
      transaction.reference,
      transaction.status,
      transaction.deletedAt,
      transaction.matchedInvoiceId,
    ],
  );
  return transaction.id;
}

async function flagOf(transactionId: string) {
  const { rows } = await db.query(
    `select review_invoice_id as invoice, review_reason as reason, flagged_at as at
     from transaction
     where id = $1`,
    [transactionId],
  );
  return rows[0];
}

async function pairingOf(transactionId: string) {
  const { rows } = await db.query(
    `select matched_invoice_id as invoice, match_evidence as evidence, matched_at as at
     from transaction
     where id = $1`,
    [transactionId],
  );
  return rows[0];
}

beforeEach(async () => {
  await db.query("truncate company, account, buying_invoice, transaction");
  ({ companyId, accountId } = await givenCompany(SIREN));
});

afterAll(() => db.end());

describe("runAutoMatching", () => {
  it("pairs a payment with the invoice its label names, and records why", async () => {
    const invoice = await givenInvoice();
    const transaction = await givenTransaction();

    const summary = await runAutoMatching(SIREN);

    const pairing = await pairingOf(transaction);
    expect(pairing.invoice).toBe(invoice);
    expect(pairing.evidence).toBe("supplier");
    expect(pairing.at).toBeInstanceOf(Date);
    expect(summary).toMatchObject({ considered: 1, matched: { reference: 0, supplier: 1 } });
  });

  it("compares amounts to the cent", async () => {
    const invoice = await givenInvoice({ taxFreeCents: 51283, vatCents: 10257 }); // 512.83 + 102.57
    const transaction = await givenTransaction({ amountCents: -61540 });

    await runAutoMatching(SIREN);

    expect((await pairingOf(transaction)).invoice).toBe(invoice);
  });

  // The payment is made on 29 March 2026, the day the clocks change in France.
  it.each([
    ["3 days before the payment", "2026-03-26", true],
    ["4 days before the payment", "2026-03-25", false],
    ["30 days after the payment", "2026-04-28", true],
    ["31 days after the payment", "2026-04-29", false],
    ["unknown", null, false],
  ])("a due date %s (%s) gives a pairing: %s", async (_when, dueDate, expected) => {
    await givenInvoice({ dueDate });
    const transaction = await givenTransaction({ date: "2026-03-29" });

    await runAutoMatching(SIREN);

    expect((await pairingOf(transaction)).invoice !== null).toBe(expected);
  });

  it.each([
    ["already paid", { status: "Paid" }],
    ["cancelled", { status: "Cancelled" }],
    ["deleted", { deletedAt: new Date() }],
    ["from another company", { otherCompany: true }],
  ])("never pairs with an invoice that is %s", async (_state, state) => {
    const other = await givenCompany("222222222");
    const { otherCompany, ...overrides } = state as { otherCompany?: boolean };
    await givenInvoice(otherCompany ? { companyId: other.companyId } : overrides);
    const transaction = await givenTransaction();

    const summary = await runAutoMatching(SIREN);

    expect((await pairingOf(transaction)).invoice).toBeNull();
    expect(summary.unmatched.no_candidate).toBe(1);
  });

  it.each([
    ["incoming", { amountCents: 12000 }],
    ["still pending at the bank", { status: "Pending" }],
    ["deleted", { deletedAt: new Date() }],
  ])("ignores a transaction that is %s", async (_state, overrides) => {
    await givenInvoice();
    const transaction = await givenTransaction(overrides);

    const summary = await runAutoMatching(SIREN);

    expect((await pairingOf(transaction)).invoice).toBeNull();
    expect(summary.considered).toBe(0);
  });

  it("leaves an existing pairing alone and does not reuse its invoice", async () => {
    const invoice = await givenInvoice();
    const byHand = await givenTransaction({ matchedInvoiceId: invoice });
    const later = await givenTransaction();

    await runAutoMatching(SIREN);

    expect(await pairingOf(byHand)).toMatchObject({ invoice, evidence: null });
    expect((await pairingOf(later)).invoice).toBeNull();
  });

  it("does not pair on amount and date alone", async () => {
    await givenInvoice({ supplier: "Allianz" });
    const transaction = await givenTransaction({ label: "PRLV SEPA HISCOX" });

    const summary = await runAutoMatching(SIREN);

    expect((await pairingOf(transaction)).invoice).toBeNull();
    expect(summary.unmatched.no_evidence).toBe(1);
  });

  it("abstains between two invoices that nothing tells apart", async () => {
    await givenInvoice({ number: "INV-1" });
    await givenInvoice({ number: "INV-2" });
    const transaction = await givenTransaction();

    const summary = await runAutoMatching(SIREN);

    expect((await pairingOf(transaction)).invoice).toBeNull();
    expect(summary.unmatched.ambiguous).toBe(1);
  });

  it("lets the bank reference choose between them", async () => {
    await givenInvoice({ number: "INV-1" });
    const second = await givenInvoice({ number: "INV-2" });
    const transaction = await givenTransaction({ reference: "INV-2" });

    await runAutoMatching(SIREN);

    expect(await pairingOf(transaction)).toMatchObject({ invoice: second, evidence: "reference" });
  });

  it("reports a second payment of an invoice that is already paid", async () => {
    const invoice = await givenInvoice();
    await givenTransaction({ reference: "INV-1", matchedInvoiceId: invoice });
    const second = await givenTransaction({ reference: "INV-1", date: "2026-03-12" });

    const summary = await runAutoMatching(SIREN);

    expect((await pairingOf(second)).invoice).toBeNull();
    expect(summary.toReview).toEqual([
      { transactionId: second, invoiceId: invoice, invoice: "paired" },
    ]);
  });

  it("reports a payment of a cancelled invoice", async () => {
    const invoice = await givenInvoice({ status: "Cancelled" });
    const transaction = await givenTransaction({ reference: "INV-1" });

    const summary = await runAutoMatching(SIREN);

    expect((await pairingOf(transaction)).invoice).toBeNull();
    expect(summary.toReview).toEqual([
      { transactionId: transaction, invoiceId: invoice, invoice: "cancelled" },
    ]);
  });

  it("flags a payment once, then leaves it out of later runs", async () => {
    const invoice = await givenInvoice({ status: "Paid" });
    const transaction = await givenTransaction({ reference: "INV-1" });

    await runAutoMatching(SIREN);
    const flag = await flagOf(transaction);
    const second = await runAutoMatching(SIREN);

    expect(flag).toMatchObject({ invoice, reason: "paid" });
    expect(flag.at).toBeInstanceOf(Date);
    expect(second).toMatchObject({ considered: 0, toReview: [] });
    expect(await flagOf(transaction)).toEqual(flag);
  });

  it("gives an invoice claimed by two transactions to neither", async () => {
    await givenInvoice();
    const first = await givenTransaction();
    const duplicate = await givenTransaction();

    const summary = await runAutoMatching(SIREN);

    expect((await pairingOf(first)).invoice).toBeNull();
    expect((await pairingOf(duplicate)).invoice).toBeNull();
    expect(summary.unmatched.contested).toBe(2);
  });

  it("does not touch the transactions of another company", async () => {
    const other = await givenCompany("222222222");
    await givenInvoice({ companyId: other.companyId });
    const theirs = await givenTransaction({ accountId: other.accountId });

    await runAutoMatching(SIREN);

    expect((await pairingOf(theirs)).invoice).toBeNull();
  });

  it("changes nothing when it runs again", async () => {
    const invoice = await givenInvoice();
    const transaction = await givenTransaction();
    await runAutoMatching(SIREN);
    const first = await pairingOf(transaction);

    const summary = await runAutoMatching(SIREN);

    expect(summary.considered).toBe(0);
    expect(await pairingOf(transaction)).toEqual(first);
    expect(first.invoice).toBe(invoice);
  });

  it.each([["000000000"], ["' or ''='"]])(
    "fails on the unknown SIREN %s without writing anything",
    async (siren) => {
      await givenInvoice();
      const transaction = await givenTransaction();

      // The cast skips parseSiren on purpose: even unchecked, the value is only data to Postgres.
      await expect(runAutoMatching(siren as Siren)).rejects.toThrow("No company with SIREN");

      expect((await pairingOf(transaction)).invoice).toBeNull();
    },
  );
});

describe("parseSiren", () => {
  it("accepts 9 digits", () => {
    expect(parseSiren("900997767")).toBe("900997767");
  });

  it.each([[""], ["90099776"], ["9009977670"], ["900 997 767"], ["900997767\n"], ["' or ''='"]])(
    "refuses %j",
    (input) => {
      expect(() => parseSiren(input)).toThrow("Not a SIREN");
    },
  );
});
