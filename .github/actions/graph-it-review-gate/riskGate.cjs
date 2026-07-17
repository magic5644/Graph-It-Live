function runRiskGate(risk = "", threshold = "") {
  if (threshold === "") return 0;

  let shouldFail;
  if (threshold === "high") {
    shouldFail = risk === "high" || risk === "critical";
  } else if (threshold === "critical") {
    shouldFail = risk === "critical";
  }

  if (shouldFail === undefined) {
    console.error(`Invalid fail-on-risk value: ${threshold} (use high or critical)`);
    return 2;
  }

  if (shouldFail) {
    console.error(`Graph-It Review Gate failed: risk=${risk} threshold=${threshold}`);
    return 1;
  }

  return 0;
}

if (require.main === module) {
  process.exitCode = runRiskGate(process.env.RISK, process.env.THRESHOLD);
}

module.exports = { runRiskGate };