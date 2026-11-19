import { describe, expect, it } from "vitest";
import { Workflow, WorkflowError } from "../src/index.js";
import { buildOrg, buildWorkflow, submittedRequisition } from "./fixtures.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as WorkflowError).code;
  }
  return "NO_ERROR";
};

describe("requisitions", () => {
  it("are born with one account group and never mix", () => {
    const { wf } = buildWorkflow();
    wf.createRequisition({ id: "R", requesterId: "ana", branchId: "HQ", accountGroup: "goods" });
    wf.addItem("R", { sku: "A", qty: 1, unitPrice: 10, accountGroup: "goods" });
    expect(code(() => wf.addItem("R", { sku: "S", qty: 1, unitPrice: 10, accountGroup: "services" }))).toBe(
      "MIXED_ACCOUNT_GROUP",
    );
  });

  it("cannot be submitted empty or by someone else", () => {
    const { wf } = buildWorkflow();
    wf.createRequisition({ id: "R", requesterId: "ana", branchId: "HQ", accountGroup: "goods" });
    expect(code(() => wf.submit("R", "ana"))).toBe("EMPTY");
    wf.addItem("R", { sku: "A", qty: 1, unitPrice: 10, accountGroup: "goods" });
    expect(code(() => wf.submit("R", "rita"))).toBe("FORBIDDEN");
  });

  it("are locked after submission", () => {
    const { wf } = buildWorkflow();
    submittedRequisition(wf);
    expect(code(() => wf.addItem("REQ-1", { sku: "B", qty: 1, unitPrice: 1, accountGroup: "goods" }))).toBe("LOCKED");
  });

  it("reject invalid items", () => {
    const { wf } = buildWorkflow();
    wf.createRequisition({ id: "R", requesterId: "ana", branchId: "HQ", accountGroup: "goods" });
    expect(code(() => wf.addItem("R", { sku: "A", qty: 0, unitPrice: 1, accountGroup: "goods" }))).toBe("INVALID_ITEM");
    expect(code(() => wf.addItem("R", { sku: "A", qty: 1, unitPrice: -1, accountGroup: "goods" }))).toBe("INVALID_ITEM");
  });

  it("can only be opened for a branch the requester works for", () => {
    const org = buildOrg();
    org.hire({ id: "hq-only", name: "x", roleId: "buyer", branchIds: ["HQ"] });
    const wf = new Workflow(org);
    expect(code(() => wf.createRequisition({ id: "R", requesterId: "hq-only", branchId: "BR-B", accountGroup: "goods" }))).toBe(
      "WRONG_BRANCH",
    );
  });
});

describe("approval gate", () => {
  it("a coordinator approves within their limit", () => {
    const { wf } = buildWorkflow();
    submittedRequisition(wf, { amount: 8_000 });
    wf.approve("REQ-1", "caio");
    expect(wf.requisitions.get("REQ-1")!.status).toBe("approved");
  });

  it("blocks approval above the role limit", () => {
    const { wf } = buildWorkflow();
    submittedRequisition(wf, { amount: 20_000 });
    expect(code(() => wf.approve("REQ-1", "caio"))).toBe("NO_AUTHORITY");
    wf.approve("REQ-1", "rita");
    expect(wf.requisitions.get("REQ-1")!.approvedBy).toBe("rita");
  });

  it("blocks self-approval even for a director", () => {
    const { org, wf } = buildWorkflow();
    org.hire({ id: "dir2", name: "x", roleId: "director", branchIds: ["HQ"] });
    wf.createRequisition({ id: "R", requesterId: "dir2", branchId: "HQ", accountGroup: "goods" });
    wf.addItem("R", { sku: "A", qty: 1, unitPrice: 1, accountGroup: "goods" });
    wf.submit("R", "dir2");
    expect(code(() => wf.approve("R", "dir2"))).toBe("SELF_APPROVAL");
  });

  it("a former employee can never approve", () => {
    const { org, wf } = buildWorkflow();
    submittedRequisition(wf, { amount: 1_000 });
    org.terminate("caio");
    expect(() => wf.approve("REQ-1", "caio")).toThrow(/no longer active/);
  });

  it("blocks a buyer with no authority", () => {
    const { org, wf } = buildWorkflow();
    org.hire({ id: "bob", name: "Bob", roleId: "buyer", branchIds: ["HQ"] });
    submittedRequisition(wf, { amount: 1 });
    expect(code(() => wf.approve("REQ-1", "bob"))).toBe("NO_AUTHORITY");
  });

  it("only submitted requisitions can be decided", () => {
    const { wf } = buildWorkflow();
    wf.createRequisition({ id: "R", requesterId: "ana", branchId: "HQ", accountGroup: "goods" });
    expect(code(() => wf.approve("R", "rita"))).toBe("INVALID_TRANSITION");
  });

  it("a rejection needs a reason and authority", () => {
    const { wf } = buildWorkflow();
    submittedRequisition(wf, { amount: 50_000 });
    expect(code(() => wf.reject("REQ-1", "rita", "  "))).toBe("REASON_REQUIRED");
    expect(code(() => wf.reject("REQ-1", "caio", "too expensive"))).toBe("NO_AUTHORITY");
    wf.reject("REQ-1", "rita", "too expensive");
    expect(wf.requisitions.get("REQ-1")!.status).toBe("rejected");
  });
});

describe("purchase orders", () => {
  function approvedOrder(terms: "on_delivery" | "net_30" | "advance" = "on_delivery", tolerance = 0.02) {
    const { org, wf } = buildWorkflow(tolerance);
    submittedRequisition(wf, { amount: 5_000 }); // 10 units of SKU-1
    wf.approve("REQ-1", "rita");
    wf.createOrder({ id: "PO-1", requisitionId: "REQ-1", supplier: "ACME", terms, buyerId: "ana" });
    return { org, wf };
  }

  it("come only from approved requisitions", () => {
    const { wf } = buildWorkflow();
    submittedRequisition(wf);
    expect(code(() => wf.createOrder({ id: "PO", requisitionId: "REQ-1", supplier: "x", terms: "net_30", buyerId: "ana" }))).toBe(
      "NOT_APPROVED",
    );
  });

  it("advance payment needs a board-level role", () => {
    const { wf } = approvedOrder("advance");
    expect(wf.canReleasePayment("PO-1")).toBe(false);
    expect(code(() => wf.approveAdvancePayment("PO-1", "rita"))).toBe("NO_AUTHORITY");
    wf.approveAdvancePayment("PO-1", "davi");
    expect(wf.canReleasePayment("PO-1")).toBe(true);
  });

  it("advance approval is not available on normal terms", () => {
    const { wf } = approvedOrder("net_30");
    expect(code(() => wf.approveAdvancePayment("PO-1", "davi"))).toBe("NOT_ADVANCE");
  });

  it("a parent order splits into loads and closes only on total quantity", () => {
    const { wf } = approvedOrder();
    wf.planLoad("PO-1", { id: "L1", planned: { "SKU-1": 4 } }, "ana");
    wf.planLoad("PO-1", { id: "L2", planned: { "SKU-1": 6 } }, "ana");
    wf.receive("PO-1", "L1", { "SKU-1": 4 }, "wh");
    expect(wf.orders.get("PO-1")!.status).toBe("open"); // partial never closes
    expect(wf.canReleasePayment("PO-1")).toBe(false);
    wf.receive("PO-1", "L2", { "SKU-1": 6 }, "wh");
    expect(wf.orders.get("PO-1")!.status).toBe("closed");
    expect(wf.canReleasePayment("PO-1")).toBe(true);
  });

  it("closes within tolerance (98% of ordered with 2% tolerance)", () => {
    const { wf } = approvedOrder("on_delivery", 0.02);
    wf.planLoad("PO-1", { id: "L1", planned: { "SKU-1": 10 } }, "ana");
    wf.receive("PO-1", "L1", { "SKU-1": 9.8 }, "wh");
    expect(wf.orders.get("PO-1")!.status).toBe("closed");
  });

  it("stays open below tolerance", () => {
    const { wf } = approvedOrder("on_delivery", 0.02);
    wf.planLoad("PO-1", { id: "L1", planned: { "SKU-1": 10 } }, "ana");
    wf.receive("PO-1", "L1", { "SKU-1": 9.7 }, "wh");
    expect(wf.orders.get("PO-1")!.status).toBe("open");
  });

  it("cannot plan more than was ordered", () => {
    const { wf } = approvedOrder();
    wf.planLoad("PO-1", { id: "L1", planned: { "SKU-1": 8 } }, "ana");
    expect(code(() => wf.planLoad("PO-1", { id: "L2", planned: { "SKU-1": 5 } }, "ana"))).toBe("OVER_PLANNED");
  });

  it("cannot receive more than planned, or twice", () => {
    const { wf } = approvedOrder();
    wf.planLoad("PO-1", { id: "L1", planned: { "SKU-1": 5 } }, "ana");
    expect(code(() => wf.receive("PO-1", "L1", { "SKU-1": 6 }, "wh"))).toBe("OVER_RECEIVED");
    wf.receive("PO-1", "L1", { "SKU-1": 5 }, "wh");
    expect(code(() => wf.receive("PO-1", "L1", { "SKU-1": 5 }, "wh"))).toBe("ALREADY_RECEIVED");
  });

  it("rejects unknown SKUs on loads", () => {
    const { wf } = approvedOrder();
    expect(code(() => wf.planLoad("PO-1", { id: "L1", planned: { "SKU-X": 1 } }, "ana"))).toBe("UNKNOWN_SKU");
  });
});

describe("audit trail", () => {
  it("records every step with actor and sequence", () => {
    const { wf } = buildWorkflow();
    submittedRequisition(wf, { amount: 5_000 });
    wf.approve("REQ-1", "caio");
    wf.createOrder({ id: "PO-1", requisitionId: "REQ-1", supplier: "ACME", terms: "net_30", buyerId: "ana" });
    expect(wf.audit.map((e) => e.action)).toEqual([
      "requisition.created",
      "requisition.submitted",
      "requisition.approved",
      "order.created",
    ]);
    expect(wf.audit.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(wf.audit[2]).toMatchObject({ actor: "caio", detail: { role: "coordinator", total: 5_000 } });
  });

  it("rejects an unreasonable tolerance", () => {
    expect(() => new Workflow(buildOrg(), { tolerance: 0.5 })).toThrow(/tolerance/);
  });
});
