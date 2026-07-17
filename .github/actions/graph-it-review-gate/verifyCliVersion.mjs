import { appendFile } from "node:fs/promises";

export const MINIMUM_CLI_VERSION = "1.12.0";

function isAlphanumericHyphen(value) {
  return [...value].every((character) => /[0-9A-Za-z-]/.test(character));
}

function isNumericIdentifier(value) {
  return Number.isSafeInteger(Number(value)) && String(Number(value)) === value;
}

function isValidPrereleaseIdentifier(value) {
  return value.length > 0 && isAlphanumericHyphen(value) && (!/^\d+$/.test(value) || isNumericIdentifier(value));
}

function splitVersion(version) {
  const [withoutBuild, ...build] = version.split("+");
  if (build.length > 1 || build.some((part) => part.split(".").some((identifier) => !isValidPrereleaseIdentifier(identifier)))) return undefined;
  const [core, ...prerelease] = withoutBuild.split("-");
  if (prerelease.length > 1 || prerelease.some((part) => part.split(".").some((identifier) => !isValidPrereleaseIdentifier(identifier)))) return undefined;
  const parts = core.split(".");
  if (parts.length !== 3 || !parts.every(isNumericIdentifier)) return undefined;
  return { core: parts.map(Number), prerelease: prerelease[0]?.split(".") ?? [] };
}

export function parseCliVersion(output) {
  if (typeof output !== "string") return undefined;
  const line = output.split(/\r?\n/).find((candidate) => candidate.trimStart().startsWith("graph-it-live v"));
  const version = line?.trim().slice("graph-it-live v".length);
  return version && splitVersion(version) ? version : undefined;
}

function parseSemver(version) {
  const parsed = splitVersion(version);
  if (!parsed) throw new Error(`Invalid semantic version: ${version}`);
  return parsed;
}

function comparePrereleaseIdentifier(left, right) {
  if (left === right) return 0;
  const leftNumeric = isNumericIdentifier(left);
  const rightNumeric = isNumericIdentifier(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left.localeCompare(right);
}

function comparePrerelease(left, right) {
  if (left.length === 0) return right.length === 0 ? 0 : 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = comparePrereleaseIdentifier(left[index], right[index]);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function compareSemver(left, right) {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const difference = parsedLeft.core[index] - parsedRight.core[index];
    if (difference !== 0) return difference;
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export function assertSupportedCliVersion(output) {
  const version = parseCliVersion(output);
  if (!version) {
    throw new Error("Unable to parse Graph-It-Live CLI version. Expected output such as: graph-it-live v1.12.0");
  }
  if (compareSemver(version, MINIMUM_CLI_VERSION) < 0) {
    throw new Error(`Graph-It-Live CLI ${version} is unsupported; version ${MINIMUM_CLI_VERSION} or newer is required.`);
  }
  return version;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const version = assertSupportedCliVersion(Buffer.concat(chunks).toString("utf8"));
  console.log(`Using Graph-It-Live CLI ${version}`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `cli-version=${version}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}