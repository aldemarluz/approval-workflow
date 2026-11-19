/**
 * Organisation model: Department → Sector → Role → Employee, with branches.
 *
 * The key decision: approval authority belongs to the ROLE, never to a person.
 * People are assigned to roles; when someone is hired, leaves or moves, the
 * approval chain keeps working because nothing points at an individual.
 */

export type AccountGroup = "goods" | "inputs" | "services" | "freight";

export interface Branch {
  id: string;
  name: string;
  kind: "headquarters" | "branch";
}

export interface Department {
  id: string;
  name: string;
}

export interface Sector {
  id: string;
  departmentId: string;
  name: string;
}

/** What a role may approve. A role can hold several rules. */
export interface AuthorityRule {
  accountGroups: AccountGroup[];
  /** Highest requisition total this rule covers (inclusive). */
  maxAmount: number;
  /** Branches covered. Omit for every branch. */
  branchIds?: string[];
  /** Advance payments (paying before delivery) are a board-level decision. */
  canApproveAdvancePayment?: boolean;
}

export interface Role {
  id: string;
  sectorId: string;
  name: string;
  authority: AuthorityRule[];
}

export interface Employee {
  id: string;
  name: string;
  roleId: string;
  active: boolean;
  /** Branches the person works for (matrix link). */
  branchIds: string[];
}

export class OrgError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "OrgError";
  }
}

export class Org {
  readonly branches = new Map<string, Branch>();
  readonly departments = new Map<string, Department>();
  readonly sectors = new Map<string, Sector>();
  readonly roles = new Map<string, Role>();
  readonly employees = new Map<string, Employee>();

  addBranch(b: Branch): this {
    this.branches.set(b.id, b);
    return this;
  }

  addDepartment(d: Department): this {
    this.departments.set(d.id, d);
    return this;
  }

  addSector(s: Sector): this {
    if (!this.departments.has(s.departmentId)) {
      throw new OrgError("UNKNOWN_DEPARTMENT", `sector ${s.id}: department ${s.departmentId} does not exist`);
    }
    this.sectors.set(s.id, s);
    return this;
  }

  addRole(r: Role): this {
    if (!this.sectors.has(r.sectorId)) {
      throw new OrgError("UNKNOWN_SECTOR", `role ${r.id}: sector ${r.sectorId} does not exist`);
    }
    for (const rule of r.authority) {
      if (rule.maxAmount < 0) throw new OrgError("INVALID_RULE", `role ${r.id}: negative maxAmount`);
      for (const b of rule.branchIds ?? []) {
        if (!this.branches.has(b)) throw new OrgError("UNKNOWN_BRANCH", `role ${r.id}: branch ${b} does not exist`);
      }
    }
    this.roles.set(r.id, r);
    return this;
  }

  hire(e: Omit<Employee, "active">): Employee {
    if (!this.roles.has(e.roleId)) throw new OrgError("UNKNOWN_ROLE", `role ${e.roleId} does not exist`);
    for (const b of e.branchIds) {
      if (!this.branches.has(b)) throw new OrgError("UNKNOWN_BRANCH", `branch ${b} does not exist`);
    }
    const emp: Employee = { ...e, active: true };
    this.employees.set(emp.id, emp);
    return emp;
  }

  /** Someone leaves: they keep their history, but lose every authority at once. */
  terminate(employeeId: string): void {
    this.employee(employeeId).active = false;
  }

  /** Someone changes job: authority follows the new role, automatically. */
  transfer(employeeId: string, newRoleId: string): void {
    if (!this.roles.has(newRoleId)) throw new OrgError("UNKNOWN_ROLE", `role ${newRoleId} does not exist`);
    this.employee(employeeId).roleId = newRoleId;
  }

  employee(id: string): Employee {
    const e = this.employees.get(id);
    if (!e) throw new OrgError("UNKNOWN_EMPLOYEE", `employee ${id} does not exist`);
    return e;
  }

  roleOf(employeeId: string): Role {
    return this.roles.get(this.employee(employeeId).roleId)!;
  }

  /** The rule (if any) that lets an employee approve this request. */
  coveringRule(
    employeeId: string,
    req: { accountGroup: AccountGroup; total: number; branchId: string },
  ): AuthorityRule | undefined {
    const emp = this.employee(employeeId);
    if (!emp.active) return undefined;
    if (!emp.branchIds.includes(req.branchId)) return undefined;
    return this.roleOf(employeeId).authority.find(
      (r) =>
        r.accountGroups.includes(req.accountGroup) &&
        req.total <= r.maxAmount &&
        (r.branchIds === undefined || r.branchIds.includes(req.branchId)),
    );
  }

  /** Everyone who could approve this request right now. */
  approversFor(req: { accountGroup: AccountGroup; total: number; branchId: string }): Employee[] {
    return [...this.employees.values()]
      .filter((e) => this.coveringRule(e.id, req) !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
