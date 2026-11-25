import { describe, expect, it } from "vitest";
import {
  type Candidate,
  type Decision,
  type Unpayable,
  decide,
  labelNamesSupplier,
  suggestion,
  withoutContested,
} from "./decision";

const invoice = (
  invoiceId: string,
  supplierName: string | null,
  invoiceNumber: string | null = null,
  unpayable: Unpayable | null = null,
): Candidate => ({
  invoiceId,
  supplierName,
  invoiceNumber,
  unpayable,
});

describe("labelNamesSupplier", () => {
  it.each([
    ["PRLV SEPA DOCUSIGN", "Docusign France"],
    ["PRLV SEPA SAGE", "Sage SAS"],
    ["CB OFFICE DEPOT FRANCE", "Office Depot"],
    ["PRLV BUREAU VALLEE", "Bureau Vallée"],
    ["VIR LOYER SCI DES LILAS", "SCI des Lilas"],
  ])("%s names %s", (label, supplier) => {
    expect(labelNamesSupplier(label, supplier)).toBe(true);
  });

  it.each([
    ["VIR TRANSFERT SFRI SARL", "SFR", "a name inside a longer word is not a match"],
    ["PRLV SEPA OVH SAS", "OVHcloud", "a different company with a close name"],
    ["CB SLACK T0123", "Slack Technologies", "only part of the name is in the label"],
    ["PRLV SEPA ASSURANCE", null, "no supplier name"],
    ["PRLV SEPA ASSURANCE", "", "empty supplier name"],
    [null, "Sage SAS", "no label"],
  ])("%s does not name %s (%s)", (label, supplier, _why) => {
    expect(labelNamesSupplier(label, supplier)).toBe(false);
  });
});

describe("decide", () => {
  it("leaves the transaction unmatched when there is no candidate", () => {
    expect(decide({ label: "CB SNCF", reference: "" }, [])).toEqual({
      matched: false,
      reason: "no_candidate",
    });
  });

  it("pairs the only candidate named by the label", () => {
    const decision = decide({ label: "PRLV SEPA SAGE", reference: "" }, [
      invoice("sage", "Sage SAS"),
      invoice("qonto", "Qonto", ""),
    ]);
    expect(decision).toEqual({ matched: true, invoiceId: "sage", evidence: "supplier" });
  });

  it("does not pair a single candidate that nothing links to the bank line", () => {
    const decision = decide({ label: "PRLV SEPA HISCOX", reference: "" }, [
      invoice("allianz", "Allianz"),
    ]);
    expect(decision).toEqual({ matched: false, reason: "no_evidence" });
  });

  it("abstains when the label names several candidates", () => {
    const decision = decide({ label: "PRLV SEPA FREE PRO", reference: "" }, [
      invoice("march", "Free Pro"),
      invoice("april", "Free Pro"),
    ]);
    expect(decision).toEqual({ matched: false, reason: "ambiguous" });
  });

  it("uses the bank reference to choose between invoices of the same supplier", () => {
    const decision = decide({ label: "PRLV SEPA FREE PRO F-2", reference: "F-2" }, [
      invoice("march", "Free Pro", "F-1"),
      invoice("april", "Free Pro", "F-2"),
    ]);
    expect(decision).toEqual({ matched: true, invoiceId: "april", evidence: "reference" });
  });

  it("abstains when the reference names an invoice that is not a candidate", () => {
    const decision = decide({ label: "CB ATLASSIAN F-215", reference: "F-215" }, [
      invoice("other", "Atlassian", "F-321"),
    ]);
    expect(decision).toEqual({ matched: false, reason: "reference_mismatch" });
  });

  it("never treats an empty invoice number as a match", () => {
    const decision = decide({ label: "PRLV SEPA", reference: " " }, [
      invoice("qonto", "Qonto", ""),
    ]);
    expect(decision).toEqual({ matched: false, reason: "no_evidence" });
  });
});

describe("decide, with invoices that cannot be paid any more", () => {
  it.each<[Unpayable]>([["paid"], ["cancelled"], ["deleted"], ["paired"]])(
    "reports a reference that names a %s invoice, without pairing it",
    (state) => {
      const decision = decide({ label: "VIR ACME F-7", reference: "F-7" }, [
        invoice("settled", "Acme", "F-7", state),
        invoice("open", "Acme", "F-8"),
      ]);
      expect(decision).toEqual({
        matched: false,
        reason: "names_unpayable_invoice",
        invoiceId: "settled",
        invoice: state,
      });
    },
  );

  it("never pairs a settled invoice named by the label", () => {
    const decision = decide({ label: "PRLV SEPA ACME", reference: "" }, [
      invoice("settled", "Acme", "F-7", "paid"),
    ]);
    expect(decision).toEqual({ matched: false, reason: "no_candidate" });
  });

  it("does not report an amount and a date that only happen to fit a settled invoice", () => {
    const decision = decide({ label: "CB OTHER F-9", reference: "F-9" }, [
      invoice("settled", "Acme", "F-7", "paid"),
    ]);
    expect(decision).toEqual({ matched: false, reason: "no_candidate" });
  });
});

describe("suggestion", () => {
  const line = { label: "PRLV SEPA HISCOX", reference: "" };

  it("suggests the only candidate when nothing links it to the bank line", () => {
    const candidates = [invoice("allianz", "Allianz")];
    expect(suggestion(decide(line, candidates), candidates)).toBe("allianz");
  });

  it.each([
    ["two candidates", [invoice("a", "Allianz"), invoice("b", "Axa")]],
    ["no payable candidate", [invoice("a", "Allianz", null, "paid")]],
    ["a pairing", [invoice("hiscox", "Hiscox")]],
  ])("suggests nothing with %s", (_case, candidates) => {
    expect(suggestion(decide(line, candidates), candidates)).toBeNull();
  });
});

describe("withoutContested", () => {
  it("gives an invoice claimed by two transactions to neither", () => {
    const claim: Decision = { matched: true, invoiceId: "rent", evidence: "supplier" };
    const other: Decision = { matched: true, invoiceId: "phone", evidence: "reference" };
    const settled = withoutContested(
      new Map([
        ["t1", claim],
        ["t2", claim],
        ["t3", other],
      ]),
    );
    expect(settled.get("t1")).toEqual({ matched: false, reason: "contested" });
    expect(settled.get("t2")).toEqual({ matched: false, reason: "contested" });
    expect(settled.get("t3")).toEqual(other);
  });
});
