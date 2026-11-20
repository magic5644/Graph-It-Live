import { describe, expect, it } from "vitest";
import { unitDisplayName, unitSecondaryName } from "../../src/shared/unitDisplayName";

describe("unitDisplayName", () => {
  it("shows the package name and keeps the folder as secondary label", () => {
    const unit = { key: "packages/lib", name: "@scope/lib", folder: "packages/lib" };
    expect(unitDisplayName(unit)).toBe("@scope/lib");
    expect(unitSecondaryName(unit)).toBe("packages/lib");
  });

  it("shows the folder once when the unit has no package name", () => {
    const unit = { key: "apps/x/src/public-api", name: "apps/x/src/public-api", folder: "apps/x/src/public-api" };
    expect(unitDisplayName(unit)).toBe("apps/x/src/public-api");
    expect(unitSecondaryName(unit)).toBeUndefined();
  });

  it("reads the folder, never the key: an element unit shows its folder, a unit across folders none", () => {
    expect(unitSecondaryName({ name: "analyzer", folder: "src/analyzer" })).toBe("src/analyzer");
    expect(unitSecondaryName({ name: "tooling", folder: "" })).toBeUndefined();
    expect(unitSecondaryName({ name: "(root)", folder: "" })).toBeUndefined();
    expect(unitSecondaryName({ name: "@acme/app", folder: "packages/app" })).toBe("packages/app");
  });
});
