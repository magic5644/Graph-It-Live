// #264 E2E: this import resolves outside the tests/fixtures workspace root, so
// indexing must skip it and report it rather than drop it silently.
import { outsideRoot } from "../../out-of-root-target/shared";

export const consumer = (): number => outsideRoot;
