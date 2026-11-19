import { describe, expect, it } from "vitest";
import { unitDisplayName, unitSecondaryName } from "../../src/shared/unitDisplayName";

describe("unitDisplayName", () => {
  it("shows the package name and keeps the folder as secondary label", () => {
    const unit = { key: "packages/lib", name: "@scope/lib" };
    expect(unitDisplayName(unit)).toBe("@scope/lib");
    expect(unitSecondaryName(unit)).toBe("packages/lib");
  });

  it("shows the folder once when the unit has no package name", () => {
    const unit = { key: "apps/x/src/public-api", name: "apps/x/src/public-api" };
    expect(unitDisplayName(unit)).toBe("apps/x/src/public-api");
    expect(unitSecondaryName(unit)).toBeUndefined();
  });
});
