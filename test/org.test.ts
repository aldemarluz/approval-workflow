import { describe, expect, it } from "vitest";
import { Org, OrgError } from "../src/index.js";
import { buildOrg } from "./fixtures.js";

const req = (total: number, accountGroup: "goods" | "services" = "goods", branchId = "HQ") => ({
  accountGroup,
  total,
  branchId,
});

describe("authority belongs to the role", () => {
  it("finds approvers by role rules, not by name", () => {
    const org = buildOrg();
    expect(org.approversFor(req(5_000)).map((e) => e.id)).toEqual(["caio", "davi", "rita"]);
    expect(org.approversFor(req(50_000)).map((e) => e.id)).toEqual(["davi", "rita"]);
    expect(org.approversFor(req(500_000)).map((e) => e.id)).toEqual(["davi"]);
  });

  it("respects account groups", () => {
    const org = buildOrg();
    // coordinator only covers goods/inputs
    expect(org.approversFor(req(5_000, "services")).map((e) => e.id)).toEqual(["davi", "rita"]);
  });

  it("respects branches on the rule and on the person", () => {
    const org = buildOrg();
    expect(org.approversFor(req(5_000, "goods", "BR-B")).map((e) => e.id)).toEqual(["davi", "rita"]);
  });

  it("maxAmount is inclusive", () => {
    const org = buildOrg();
    expect(org.coveringRule("caio", req(10_000))).toBeDefined();
    expect(org.coveringRule("caio", req(10_000.01))).toBeUndefined();
  });

  it("a person with no authority rules can never approve", () => {
    expect(buildOrg().coveringRule("ana", req(1))).toBeUndefined();
  });
});

describe("people change, the chain does not break", () => {
  it("a termination removes all authority immediately", () => {
    const org = buildOrg();
    org.terminate("caio");
    expect(org.coveringRule("caio", req(1_000))).toBeUndefined();
    expect(org.approversFor(req(1_000)).map((e) => e.id)).toEqual(["davi", "rita"]);
  });

  it("a new hire in the role inherits its authority with no extra setup", () => {
    const org = buildOrg();
    org.terminate("caio");
    org.hire({ id: "lia", name: "Lia", roleId: "coordinator", branchIds: ["HQ"] });
    expect(org.coveringRule("lia", req(9_000))).toBeDefined();
  });

  it("a transfer moves authority with the job", () => {
    const org = buildOrg();
    org.transfer("ana", "manager");
    expect(org.coveringRule("ana", req(90_000))).toBeDefined();
    org.transfer("rita", "buyer");
    expect(org.coveringRule("rita", req(1))).toBeUndefined();
  });
});

describe("structure is validated", () => {
  it("rejects sectors in unknown departments", () => {
    expect(() => new Org().addSector({ id: "S", departmentId: "X", name: "s" })).toThrow(OrgError);
  });

  it("rejects roles in unknown sectors", () => {
    expect(() => new Org().addRole({ id: "R", sectorId: "X", name: "r", authority: [] })).toThrow(OrgError);
  });

  it("rejects rules pointing to unknown branches", () => {
    const org = new Org().addDepartment({ id: "D", name: "d" }).addSector({ id: "S", departmentId: "D", name: "s" });
    expect(() =>
      org.addRole({ id: "R", sectorId: "S", name: "r", authority: [{ accountGroups: ["goods"], maxAmount: 1, branchIds: ["NOPE"] }] }),
    ).toThrow(/branch/);
  });

  it("rejects negative limits", () => {
    const org = new Org().addDepartment({ id: "D", name: "d" }).addSector({ id: "S", departmentId: "D", name: "s" });
    expect(() =>
      org.addRole({ id: "R", sectorId: "S", name: "r", authority: [{ accountGroups: ["goods"], maxAmount: -1 }] }),
    ).toThrow(/negative/);
  });

  it("rejects hires into unknown roles or branches", () => {
    const org = buildOrg();
    expect(() => org.hire({ id: "x", name: "x", roleId: "ghost", branchIds: ["HQ"] })).toThrow(/role/);
    expect(() => org.hire({ id: "x", name: "x", roleId: "buyer", branchIds: ["MARS"] })).toThrow(/branch/);
  });
});
