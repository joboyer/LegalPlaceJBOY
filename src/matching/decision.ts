// The decision is pure: it gets a bank line and its candidate invoices and says whether one
// of them is convincing. No database and no clock, so every rule has a unit test.

export type BankLine = {
  label: string | null;
  reference: string | null;
};

/** Why an invoice cannot be paid any more. null: it can. */
export type Unpayable = "paid" | "cancelled" | "deleted" | "paired";

export type Candidate = {
  invoiceId: string;
  supplierName: string | null;
  invoiceNumber: string | null;
  unpayable: Unpayable | null;
};

export type Evidence = "reference" | "supplier";

export type Reason =
  | "no_candidate"
  | "reference_mismatch"
  | "no_evidence"
  | "ambiguous"
  | "contested"
  | "names_unpayable_invoice";

/** An eligible bank transaction with the invoices of the same amount around its date. */
export type TransactionToMatch = {
  line: BankLine;
  candidates: Candidate[];
};

export type Decision =
  | { matched: true; invoiceId: string; evidence: Evidence }
  | { matched: false; reason: Exclude<Reason, "names_unpayable_invoice"> }
  // The reference names an invoice that is already paid, cancelled or deleted: a double
  // payment, a refund to claim or a pairing made by hand. Only a person can tell.
  | { matched: false; reason: "names_unpayable_invoice"; invoiceId: string; invoice: Unpayable };

// Words that say what kind of company it is, not which one.
const GENERIC_WORDS = new Set(["sa", "sas", "sasu", "sarl", "eurl", "snc", "sci", "france"]);

/** Lower-case words without accents: "Bureau Vallée" gives ["bureau", "vallee"]. */
export function words(text: string | null): string[] {
  return (text ?? "")
    .normalize("NFD") // "é" becomes "e" followed by a separate accent mark
    .replace(/[\u0300-\u036f]/g, "") // which this range removes
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when every distinctive word of the supplier name is a whole word of the label. */
export function labelNamesSupplier(label: string | null, supplierName: string | null): boolean {
  const labelWords = new Set(words(label));
  const nameWords = words(supplierName);
  const distinctive = nameWords.filter((word) => !GENERIC_WORDS.has(word));
  const required = distinctive.length > 0 ? distinctive : nameWords;
  return required.length > 0 && required.every((word) => labelWords.has(word));
}

function isNumber(invoiceNumber: string | null, reference: string): boolean {
  return (invoiceNumber ?? "").trim().toLowerCase() === reference.toLowerCase();
}

/**
 * Amount and date only make an invoice a candidate. A pairing also needs a link between the
 * bank line and the invoice:
 * - the bank reference is the invoice number, or
 * - there is no reference and the label names the supplier.
 * With no link, or with a link to several candidates, the transaction stays unmatched.
 * Only payable invoices are paired. When the reference names an invoice that is not payable,
 * the transaction is reported for review instead.
 */
export function decide(line: BankLine, candidates: Candidate[]): Decision {
  const payable = candidates.filter((candidate) => candidate.unpayable === null);
  const reference = (line.reference ?? "").trim();

  if (reference !== "") {
    const named = candidates.filter((candidate) => isNumber(candidate.invoiceNumber, reference));
    const [only] = named;
    if (named.length === 1 && only.unpayable !== null) {
      return {
        matched: false,
        reason: "names_unpayable_invoice",
        invoiceId: only.invoiceId,
        invoice: only.unpayable,
      };
    }
  }

  if (payable.length === 0) {
    return { matched: false, reason: "no_candidate" };
  }

  const named =
    reference !== ""
      ? // The payer named an invoice: no other invoice may be paired with this line.
        payable.filter((candidate) => isNumber(candidate.invoiceNumber, reference))
      : payable.filter((candidate) => labelNamesSupplier(line.label, candidate.supplierName));

  if (named.length === 1) {
    return {
      matched: true,
      invoiceId: named[0].invoiceId,
      evidence: reference !== "" ? "reference" : "supplier",
    };
  }
  if (named.length > 1) {
    return { matched: false, reason: "ambiguous" };
  }
  return { matched: false, reason: reference !== "" ? "reference_mismatch" : "no_evidence" };
}

/**
 * The invoice to suggest for a transaction left open: its only payable candidate, when nothing
 * links them. Amount and date are not enough to pair, but enough to ask a person.
 */
export function suggestion(decision: Decision, candidates: Candidate[]): string | null {
  const payable = candidates.filter((candidate) => candidate.unpayable === null);
  const lone = !decision.matched && decision.reason === "no_evidence" && payable.length === 1;
  return lone ? payable[0].invoiceId : null;
}

/** An invoice claimed by several transactions goes to none of them. */
export function withoutContested<Id>(decisions: Map<Id, Decision>): Map<Id, Decision> {
  const claims = new Map<string, number>();
  for (const decision of decisions.values()) {
    if (decision.matched) {
      claims.set(decision.invoiceId, (claims.get(decision.invoiceId) ?? 0) + 1);
    }
  }

  const settled = new Map<Id, Decision>();
  for (const [id, decision] of decisions) {
    const contested = decision.matched && (claims.get(decision.invoiceId) ?? 0) > 1;
    settled.set(id, contested ? { matched: false, reason: "contested" } : decision);
  }
  return settled;
}

export type Outcome = { decision: Decision; suggestedInvoiceId: string | null };

/** Decides every transaction of a run, then settles the invoices claimed twice. */
export function decideAll<Id>(transactions: Map<Id, TransactionToMatch>): Map<Id, Outcome> {
  const decisions = new Map<Id, Decision>();
  for (const [id, { line, candidates }] of transactions) {
    decisions.set(id, decide(line, candidates));
  }

  const outcomes = new Map<Id, Outcome>();
  for (const [id, decision] of withoutContested(decisions)) {
    const candidates = transactions.get(id)?.candidates ?? [];
    outcomes.set(id, { decision, suggestedInvoiceId: suggestion(decision, candidates) });
  }
  return outcomes;
}
