/**
 * Exit code of the Review Gate: 1 when the risk reaches `threshold` (high or critical; empty
 * keeps the gate informative) or when the review found new error violations of the
 * architecture rules (`architectureNewErrors`, as check-architecture fails on them), 2 on an
 * invalid threshold.
 */
function runRiskGate(risk = "", threshold = "", architectureNewErrors = "") {
  let shouldFail = false;
  if (threshold === "high") {
    shouldFail = risk === "high" || risk === "critical";
  } else if (threshold === "critical") {
    shouldFail = risk === "critical";
  } else if (threshold !== "") {
    console.error(`Invalid fail-on-risk value: ${threshold} (use high or critical)`);
    return 2;
  }

  const newErrors = Number.parseInt(architectureNewErrors, 10);
  if (newErrors > 0) {
    console.error(`Graph-It Review Gate failed: ${newErrors} new error violation(s) of the architecture rules`);
    return 1;
  }

  if (shouldFail) {
    console.error(`Graph-It Review Gate failed: risk=${risk} threshold=${threshold}`);
    return 1;
  }

  return 0;
}

if (require.main === module) {
  process.exitCode = runRiskGate(process.env.RISK, process.env.THRESHOLD, process.env.ARCHITECTURE_NEW_ERRORS);
}

module.exports = { runRiskGate };
