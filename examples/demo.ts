/**
 * A week in procurement, end to end.  Run with:  npm run demo
 */
import { Workflow, WorkflowError } from "../src/index.js";
import { buildOrg } from "../test/fixtures.js";

const org = buildOrg();
const wf = new Workflow(org, { tolerance: 0.02 });
const step = (msg: string) => console.log(`\n▸ ${msg}`);
const tryIt = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ✔ ${label}`);
  } catch (e) {
    console.log(`  ✘ ${label} → ${(e as WorkflowError).code}: ${(e as Error).message}`);
  }
};

step("Ana (buyer) opens a requisition for 1,000 units of raw material at HQ — 12,000.00 total");
wf.createRequisition({ id: "REQ-42", requesterId: "ana", branchId: "HQ", accountGroup: "inputs" });
wf.addItem("REQ-42", { sku: "RAW-7", qty: 1000, unitPrice: 12, accountGroup: "inputs" });
tryIt("add a freight line to the same requisition", () =>
  wf.addItem("REQ-42", { sku: "FREIGHT", qty: 1, unitPrice: 800, accountGroup: "freight" }),
);
wf.submit("REQ-42", "ana");

step("Who can approve it? (answered by roles, not by a list of names)");
console.log("  ", org.approversFor({ accountGroup: "inputs", total: 12_000, branchId: "HQ" }).map((e) => e.name));
tryIt("Caio (coordinator, limit 10k) approves", () => wf.approve("REQ-42", "caio"));

step("Rita, the manager, leaves the company. A new manager is hired into the same role.");
org.terminate("rita");
org.hire({ id: "leo", name: "Leo (new manager)", roleId: "manager", branchIds: ["HQ", "BR-A", "BR-B"] });
tryIt("Rita tries to approve after leaving", () => wf.approve("REQ-42", "rita"));
tryIt("Leo approves on day one, no reconfiguration", () => wf.approve("REQ-42", "leo"));

step("Purchase order on advance-payment terms");
wf.createOrder({ id: "PO-42", requisitionId: "REQ-42", supplier: "Supplier Co.", terms: "advance", buyerId: "ana" });
console.log("  can release payment?", wf.canReleasePayment("PO-42"));
tryIt("Leo (manager) approves the advance", () => wf.approveAdvancePayment("PO-42", "leo"));
tryIt("Davi (director) approves the advance", () => wf.approveAdvancePayment("PO-42", "davi"));
console.log("  can release payment?", wf.canReleasePayment("PO-42"));

step("The supplier ships in two trucks; the warehouse receives against each load");
wf.planLoad("PO-42", { id: "TRUCK-1", planned: { "RAW-7": 600 } }, "ana");
wf.planLoad("PO-42", { id: "TRUCK-2", planned: { "RAW-7": 400 } }, "ana");
wf.receive("PO-42", "TRUCK-1", { "RAW-7": 600 }, "warehouse");
console.log("  after truck 1:", wf.orders.get("PO-42")!.status, wf.receivedTotals("PO-42"));
wf.receive("PO-42", "TRUCK-2", { "RAW-7": 395 }, "warehouse");
console.log("  after truck 2:", wf.orders.get("PO-42")!.status, wf.receivedTotals("PO-42"), "(within 2% tolerance)");

step("Audit trail");
for (const e of wf.audit) console.log(`  #${e.seq} ${e.actor.padEnd(9)} ${e.action.padEnd(24)} ${e.target}`);
