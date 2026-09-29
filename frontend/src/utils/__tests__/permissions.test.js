import { can, isSuperAdmin, PERMISSIONS } from "../permissions";

describe("permissions (#1581)", () => {
  it("grants every permission to super-admins (new and legacy shapes)", () => {
    for (const perm of Object.keys(PERMISSIONS)) {
      expect(can(["super_admin"], perm)).toBe(true);
      expect(can(["admin"], perm)).toBe(true);
    }
    expect(isSuperAdmin(["super_admin"])).toBe(true);
    expect(isSuperAdmin(["owner"])).toBe(false);
  });

  it("lets read_only users read but not write", () => {
    expect(can(["read_only"], "students.read")).toBe(true);
    expect(can(["read_only"], "students.write")).toBe(false);
    expect(can(["read_only"], "payments.write")).toBe(false);
  });

  it("restricts refunds and user management to owners", () => {
    expect(can(["owner"], "refunds.write")).toBe(true);
    expect(can(["staff"], "refunds.write")).toBe(false);
    expect(can(["owner"], "users.manage")).toBe(true);
    expect(can(["staff"], "users.manage")).toBe(false);
  });

  it("keeps super-admin-only permissions closed to school roles", () => {
    for (const perm of ["settings.write", "sessions.manage", "paymentPlans.write"]) {
      expect(can(["owner", "staff"], perm)).toBe(false);
    }
  });

  it("denies unknown permissions and missing roles", () => {
    expect(can(["owner"], "does.not.exist")).toBe(false);
    expect(can(undefined, "students.read")).toBe(false);
    expect(can([], "students.read")).toBe(false);
  });
});
