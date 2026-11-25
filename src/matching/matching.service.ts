import { db } from "../db";
import { type Evidence, type Outcome, type Reason, decideAll } from "./decision";
import {
  type Flag,
  type OpenState,
  type Pairing,
  findTransactionsToMatch,
  lockCompany,
  saveFlags,
  saveOpenStates,
  savePairings,
} from "./matching.repository";
import type { Siren } from "./siren";

// README: the due date is between 3 days before and 30 days after the transaction date.
const DUE_DATE_WINDOW = { daysBefore: 3, daysAfter: 30 };

export type RunSummary = {
  /** Eligible transactions the run looked at. */
  considered: number;
  matched: Record<Evidence, number>;
  unmatched: Record<Reason, number>;
  /** Open transactions with a lone candidate to confirm by hand. */
  suggested: number;
  /** Payments flagged by this run: their reference names an invoice already settled. */
  toReview: Flag[];
};

/** What the run writes: each outcome goes to exactly one of the three lists. */
function toWrites(outcomes: Map<string, Outcome>) {
  const pairings: Pairing[] = [];
  const flags: Flag[] = [];
  const openStates: OpenState[] = [];
  for (const [transactionId, { decision, suggestedInvoiceId }] of outcomes) {
    if (decision.matched) {
      const { invoiceId, evidence } = decision;
      pairings.push({ transactionId, invoiceId, evidence });
    } else if (decision.reason === "names_unpayable_invoice") {
      const { invoiceId, invoice } = decision;
      flags.push({ transactionId, invoiceId, invoice });
    } else {
      openStates.push({ transactionId, reason: decision.reason, suggestedInvoiceId });
    }
  }
  return { pairings, flags, openStates };
}

function summarize(outcomes: Map<string, Outcome>, flags: Flag[]): RunSummary {
  const summary: RunSummary = {
    considered: outcomes.size,
    matched: { reference: 0, supplier: 0 },
    unmatched: {
      no_candidate: 0,
      reference_mismatch: 0,
      no_evidence: 0,
      ambiguous: 0,
      contested: 0,
      names_unpayable_invoice: 0,
    },
    suggested: 0,
    toReview: flags,
  };
  for (const { decision, suggestedInvoiceId } of outcomes.values()) {
    if (decision.matched) {
      summary.matched[decision.evidence]++;
    } else {
      summary.unmatched[decision.reason]++;
    }
    if (suggestedInvoiceId !== null) {
      summary.suggested++;
    }
  }
  return summary;
}

/**
 * Pairs the unmatched outgoing transactions of a company with the supplier invoices they
 * pay. The whole run is one database transaction: it writes everything or nothing.
 */
export async function runAutoMatching(companySiren: Siren): Promise<RunSummary> {
  const client = await db.connect();
  try {
    await client.query("begin");

    const companyId = await lockCompany(client, companySiren);
    if (companyId === null) {
      throw new Error(`No company with SIREN ${companySiren}`);
    }

    const transactions = await findTransactionsToMatch(client, companyId, DUE_DATE_WINDOW);
    const outcomes = decideAll(transactions);
    const { pairings, flags, openStates } = toWrites(outcomes);
    await savePairings(client, pairings);
    await saveFlags(client, flags);
    await saveOpenStates(client, openStates);

    await client.query("commit");
    return summarize(outcomes, flags);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
