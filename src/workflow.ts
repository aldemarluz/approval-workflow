/**
 * Procure-to-pay workflow: requisition → approval → purchase order → receiving.
 *
 * Every rule below is enforced here, in code. A gate blocks the step; it does
 * not just warn about it.
 */

import { AccountGroup, Org } from "./org.js";

export class WorkflowError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

// ----------------------------------------------------------------- requisitions

export interface Item {
  sku: string;
  qty: number;
  unitPrice: number;
}

export type RequisitionStatus = "draft" | "submitted" | "approved" | "rejected" | "ordered";

export interface Requisition {
  id: string;
  requesterId: string;
  branchId: string;
  /** Fixed at creation. A requisition never mixes account groups. */
  readonly accountGroup: AccountGroup;
  items: Item[];
  status: RequisitionStatus;
  approvedBy?: string;
}

export const totalOf = (items: Item[]): number =>
  Math.round(items.reduce((s, i) => s + i.qty * i.unitPrice, 0) * 100) / 100;

// ---------------------------------------------------------------- purchase orders

export type PaymentTerms = "on_delivery" | "net_30" | "advance";

export interface Load {
  id: string;
  /** sku -> quantity planned for this load */
  planned: Record<string, number>;
  received: Record<string, number>;
  status: "in_transit" | "received";
}

export interface PurchaseOrder {
  id: string;
  requisitionId: string;
  supplier: string;
  terms: PaymentTerms;
  /** sku -> quantity ordered (the parent) */
  ordered: Record<string, number>;
  loads: Load[];
  status: "open" | "closed";
  advanceApprovedBy?: string;
}

export interface AuditEvent {
  seq: number;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

export interface WorkflowOptions {
  /** Receiving tolerance as a fraction (0.02 = ±2%). */
  tolerance?: number;
  clock?: () => Date;
}

export class Workflow {
  readonly requisitions = new Map<string, Requisition>();
  readonly orders = new Map<string, PurchaseOrder>();
  readonly audit: AuditEvent[] = [];
  private readonly tolerance: number;
  private readonly clock: () => Date;
  private seq = 0;

  constructor(private readonly org: Org, opts: WorkflowOptions = {}) {
    this.tolerance = opts.tolerance ?? 0.02;
    this.clock = opts.clock ?? (() => new Date());
    if (this.tolerance < 0 || this.tolerance > 0.2) {
      throw new WorkflowError("INVALID_TOLERANCE", "tolerance must be between 0 and 0.2");
    }
  }

  private log(actor: string, action: string, target: string, detail?: Record<string, unknown>) {
    this.audit.push({ seq: ++this.seq, at: this.clock().toISOString(), actor, action, target, detail });
  }

  private req(id: string): Requisition {
    const r = this.requisitions.get(id);
    if (!r) throw new WorkflowError("NOT_FOUND", `requisition ${id} does not exist`);
    return r;
  }

  private po(id: string): PurchaseOrder {
    const p = this.orders.get(id);
    if (!p) throw new WorkflowError("NOT_FOUND", `purchase order ${id} does not exist`);
    return p;
  }

  // ------------------------------------------------------------ requisitions

  createRequisition(input: {
    id: string;
    requesterId: string;
    branchId: string;
    accountGroup: AccountGroup;
  }): Requisition {
    if (this.requisitions.has(input.id)) throw new WorkflowError("DUPLICATE", `requisition ${input.id} exists`);
    const requester = this.org.employee(input.requesterId);
    if (!requester.active) throw new WorkflowError("INACTIVE_EMPLOYEE", "inactive employees cannot request");
    if (!requester.branchIds.includes(input.branchId)) {
      throw new WorkflowError("WRONG_BRANCH", `${requester.id} does not work for branch ${input.branchId}`);
    }
    const r: Requisition = { ...input, items: [], status: "draft" };
    this.requisitions.set(r.id, r);
    this.log(input.requesterId, "requisition.created", r.id, { accountGroup: r.accountGroup });
    return r;
  }

  addItem(reqId: string, item: Item & { accountGroup: AccountGroup }): void {
    const r = this.req(reqId);
    if (r.status !== "draft") throw new WorkflowError("LOCKED", "only draft requisitions can change");
    if (item.accountGroup !== r.accountGroup) {
      throw new WorkflowError(
        "MIXED_ACCOUNT_GROUP",
        `requisition ${r.id} is "${r.accountGroup}"; a "${item.accountGroup}" item needs its own requisition`,
      );
    }
    if (!(item.qty > 0) || !(item.unitPrice >= 0)) throw new WorkflowError("INVALID_ITEM", "qty must be > 0, price >= 0");
    r.items.push({ sku: item.sku, qty: item.qty, unitPrice: item.unitPrice });
  }

  submit(reqId: string, actorId: string): void {
    const r = this.req(reqId);
    if (r.status !== "draft") throw new WorkflowError("INVALID_TRANSITION", `cannot submit from ${r.status}`);
    if (actorId !== r.requesterId) throw new WorkflowError("FORBIDDEN", "only the requester can submit");
    if (r.items.length === 0) throw new WorkflowError("EMPTY", "a requisition needs at least one item");
    r.status = "submitted";
    this.log(actorId, "requisition.submitted", r.id, { total: totalOf(r.items) });
  }

  approve(reqId: string, approverId: string): void {
    const r = this.req(reqId);
    if (r.status !== "submitted") throw new WorkflowError("INVALID_TRANSITION", `cannot approve from ${r.status}`);
    if (approverId === r.requesterId) throw new WorkflowError("SELF_APPROVAL", "nobody approves their own requisition");
    const total = totalOf(r.items);
    const rule = this.org.coveringRule(approverId, { accountGroup: r.accountGroup, total, branchId: r.branchId });
    if (!rule) {
      const emp = this.org.employee(approverId);
      const why = !emp.active ? "employee is no longer active" : "role has no authority for this group, amount or branch";
      throw new WorkflowError("NO_AUTHORITY", `${approverId} cannot approve ${r.id}: ${why}`);
    }
    r.status = "approved";
    r.approvedBy = approverId;
    this.log(approverId, "requisition.approved", r.id, { total, role: this.org.roleOf(approverId).id });
  }

  reject(reqId: string, approverId: string, reason: string): void {
    const r = this.req(reqId);
    if (r.status !== "submitted") throw new WorkflowError("INVALID_TRANSITION", `cannot reject from ${r.status}`);
    if (!reason.trim()) throw new WorkflowError("REASON_REQUIRED", "a rejection needs a reason");
    const total = totalOf(r.items);
    if (!this.org.coveringRule(approverId, { accountGroup: r.accountGroup, total, branchId: r.branchId })) {
      throw new WorkflowError("NO_AUTHORITY", `${approverId} cannot decide on ${r.id}`);
    }
    r.status = "rejected";
    this.log(approverId, "requisition.rejected", r.id, { reason });
  }

  // ------------------------------------------------------------ purchase orders

  createOrder(input: { id: string; requisitionId: string; supplier: string; terms: PaymentTerms; buyerId: string }): PurchaseOrder {
    const r = this.req(input.requisitionId);
    if (r.status !== "approved") throw new WorkflowError("NOT_APPROVED", "orders come only from approved requisitions");
    if (this.orders.has(input.id)) throw new WorkflowError("DUPLICATE", `order ${input.id} exists`);
    const ordered: Record<string, number> = {};
    for (const i of r.items) ordered[i.sku] = (ordered[i.sku] ?? 0) + i.qty;
    const po: PurchaseOrder = {
      id: input.id,
      requisitionId: r.id,
      supplier: input.supplier,
      terms: input.terms,
      ordered,
      loads: [],
      status: "open",
    };
    this.orders.set(po.id, po);
    r.status = "ordered";
    this.log(input.buyerId, "order.created", po.id, { terms: po.terms, requisition: r.id });
    return po;
  }

  /** Advance payment is a separate, gated action — the normal path can't reach it. */
  approveAdvancePayment(poId: string, approverId: string): void {
    const po = this.po(poId);
    if (po.terms !== "advance") throw new WorkflowError("NOT_ADVANCE", "order is not on advance terms");
    const r = this.req(po.requisitionId);
    const rule = this.org.coveringRule(approverId, {
      accountGroup: r.accountGroup,
      total: totalOf(r.items),
      branchId: r.branchId,
    });
    if (!rule?.canApproveAdvancePayment) {
      throw new WorkflowError("NO_AUTHORITY", "advance payments need a role with advance-payment authority");
    }
    po.advanceApprovedBy = approverId;
    this.log(approverId, "order.advance_approved", po.id);
  }

  canReleasePayment(poId: string): boolean {
    const po = this.po(poId);
    if (po.terms === "advance") return po.advanceApprovedBy !== undefined;
    return po.status === "closed";
  }

  /** Split the parent order into loads (children). Planned quantities may not exceed what was ordered. */
  planLoad(poId: string, load: { id: string; planned: Record<string, number> }, actorId: string): Load {
    const po = this.po(poId);
    if (po.status !== "open") throw new WorkflowError("CLOSED", "order is closed");
    if (po.loads.some((l) => l.id === load.id)) throw new WorkflowError("DUPLICATE", `load ${load.id} exists`);
    for (const [sku, qty] of Object.entries(load.planned)) {
      if (!(sku in po.ordered)) throw new WorkflowError("UNKNOWN_SKU", `${sku} is not on order ${po.id}`);
      if (!(qty > 0)) throw new WorkflowError("INVALID_QTY", "planned quantity must be > 0");
      const alreadyPlanned = po.loads.reduce((s, l) => s + (l.planned[sku] ?? 0), 0);
      if (alreadyPlanned + qty > po.ordered[sku] * (1 + this.tolerance)) {
        throw new WorkflowError("OVER_PLANNED", `${sku}: loads would exceed the ordered quantity`);
      }
    }
    const l: Load = { id: load.id, planned: { ...load.planned }, received: {}, status: "in_transit" };
    po.loads.push(l);
    this.log(actorId, "load.planned", `${po.id}/${l.id}`, { planned: l.planned });
    return l;
  }

  /** The warehouse receives against a child load; the parent closes only on total quantity. */
  receive(poId: string, loadId: string, received: Record<string, number>, warehouseId: string): void {
    const po = this.po(poId);
    const load = po.loads.find((l) => l.id === loadId);
    if (!load) throw new WorkflowError("NOT_FOUND", `load ${loadId} not found on ${poId}`);
    if (load.status === "received") throw new WorkflowError("ALREADY_RECEIVED", `load ${loadId} was already received`);
    for (const [sku, qty] of Object.entries(received)) {
      if (!(sku in load.planned)) throw new WorkflowError("UNKNOWN_SKU", `${sku} was not planned for load ${loadId}`);
      if (qty < 0) throw new WorkflowError("INVALID_QTY", "received quantity cannot be negative");
      const max = load.planned[sku] * (1 + this.tolerance);
      if (qty > max) throw new WorkflowError("OVER_RECEIVED", `${sku}: received ${qty}, planned ${load.planned[sku]}`);
    }
    load.received = { ...received };
    load.status = "received";
    this.log(warehouseId, "load.received", `${po.id}/${load.id}`, { received });
    this.tryClose(po, warehouseId);
  }

  receivedTotals(poId: string): Record<string, number> {
    const po = this.po(poId);
    const out: Record<string, number> = {};
    for (const sku of Object.keys(po.ordered)) {
      out[sku] = po.loads.reduce((s, l) => s + (l.received[sku] ?? 0), 0);
    }
    return out;
  }

  private tryClose(po: PurchaseOrder, actorId: string): void {
    const totals = this.receivedTotals(po.id);
    const complete = Object.entries(po.ordered).every(
      ([sku, qty]) => totals[sku] >= qty * (1 - this.tolerance),
    );
    if (complete) {
      po.status = "closed";
      this.log(actorId, "order.closed", po.id, { totals });
    }
  }
}
