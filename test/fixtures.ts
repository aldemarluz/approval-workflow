import { Org, Workflow } from "../src/index.js";

/**
 * A small company: one headquarters, two branches.
 *
 *   Procurement (dept)
 *     └─ Purchasing (sector)
 *          ├─ buyer          — no approval authority
 *          ├─ coordinator    — goods/inputs up to 10k, HQ + branch A
 *          └─ manager        — any group up to 100k, every branch
 *   Board (dept)
 *     └─ Executive (sector)
 *          └─ director       — anything up to 1M, can approve advance payments
 */
export function buildOrg(): Org {
  const org = new Org()
    .addBranch({ id: "HQ", name: "Headquarters", kind: "headquarters" })
    .addBranch({ id: "BR-A", name: "Branch A", kind: "branch" })
    .addBranch({ id: "BR-B", name: "Branch B", kind: "branch" })
    .addDepartment({ id: "PROC", name: "Procurement" })
    .addDepartment({ id: "BOARD", name: "Board" })
    .addSector({ id: "PURCH", departmentId: "PROC", name: "Purchasing" })
    .addSector({ id: "EXEC", departmentId: "BOARD", name: "Executive" })
    .addRole({ id: "buyer", sectorId: "PURCH", name: "Buyer", authority: [] })
    .addRole({
      id: "coordinator",
      sectorId: "PURCH",
      name: "Purchasing Coordinator",
      authority: [{ accountGroups: ["goods", "inputs"], maxAmount: 10_000, branchIds: ["HQ", "BR-A"] }],
    })
    .addRole({
      id: "manager",
      sectorId: "PURCH",
      name: "Procurement Manager",
      authority: [{ accountGroups: ["goods", "inputs", "services", "freight"], maxAmount: 100_000 }],
    })
    .addRole({
      id: "director",
      sectorId: "EXEC",
      name: "Director",
      authority: [
        { accountGroups: ["goods", "inputs", "services", "freight"], maxAmount: 1_000_000, canApproveAdvancePayment: true },
      ],
    });

  org.hire({ id: "ana", name: "Ana (buyer)", roleId: "buyer", branchIds: ["HQ", "BR-A", "BR-B"] });
  org.hire({ id: "caio", name: "Caio (coordinator)", roleId: "coordinator", branchIds: ["HQ", "BR-A"] });
  org.hire({ id: "rita", name: "Rita (manager)", roleId: "manager", branchIds: ["HQ", "BR-A", "BR-B"] });
  org.hire({ id: "davi", name: "Davi (director)", roleId: "director", branchIds: ["HQ", "BR-A", "BR-B"] });
  return org;
}

export function fixedClock() {
  let t = Date.UTC(2026, 0, 1, 9, 0, 0);
  return () => new Date((t += 60_000));
}

export function buildWorkflow(tolerance = 0.02) {
  const org = buildOrg();
  const wf = new Workflow(org, { tolerance, clock: fixedClock() });
  return { org, wf };
}

/** Draft → items → submitted, ready for a decision. */
export function submittedRequisition(
  wf: Workflow,
  opts: { id?: string; amount?: number; group?: "goods" | "inputs" | "services" | "freight"; branch?: string } = {},
) {
  const id = opts.id ?? "REQ-1";
  const group = opts.group ?? "goods";
  wf.createRequisition({ id, requesterId: "ana", branchId: opts.branch ?? "HQ", accountGroup: group });
  wf.addItem(id, { sku: "SKU-1", qty: 10, unitPrice: (opts.amount ?? 5_000) / 10, accountGroup: group });
  wf.submit(id, "ana");
  return id;
}
