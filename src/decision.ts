// The decision is pure: it gets a bank line and its candidate invoices and says whether one
// of them is convincing. No database and no clock, so every rule has a unit test.

export type BankLine = {
  label: string | null;
  reference: string | null;
};

export type Candidate = {
  invoiceId: string;
  supplierName: string | null;
  invoiceNumber: string | null;
};

export type Evidence = "reference" | "supplier";

export type Reason =
  | "no_candidate"
  | "reference_mismatch"
  | "no_evidence"
  | "ambiguous"
  | "contested";

export type Decision =
  | { matched: true; invoiceId: string; evidence: Evidence }
  | { matched: false; reason: Reason };

// Words that say what kind of company it is, not which one.
const GENERIC_WORDS = new Set(["sa", "sas", "sasu", "sarl", "eurl", "snc", "sci", "france"]);

/** Lower-case words without accents: "Bureau Vallée" gives ["bureau", "vallee"]. */
export function words(text: string | null): string[] {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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
 */
export function decide(line: BankLine, candidates: Candidate[]): Decision {
  if (candidates.length === 0) {
    return { matched: false, reason: "no_candidate" };
  }

  const reference = (line.reference ?? "").trim();
  const named =
    reference !== ""
      ? // The payer named an invoice: no other invoice may be paired with this line.
        candidates.filter((candidate) => isNumber(candidate.invoiceNumber, reference))
      : candidates.filter((candidate) => labelNamesSupplier(line.label, candidate.supplierName));

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
