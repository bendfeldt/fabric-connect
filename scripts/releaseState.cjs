const fs = require("node:fs");

function classifyRelease(status, response, assetName) {
  if (!Number.isInteger(status) || status < 0) {
    throw new Error("GitHub API status must be a nonnegative integer.");
  }
  if (typeof response !== "string" || typeof assetName !== "string") {
    throw new Error("GitHub release response and asset name must be strings.");
  }
  if (status !== 0) {
    if (/\bHTTP 404\b/.test(response)) return "absent";
    throw new Error(
      response.trim() || `GitHub API failed with status ${status}.`,
    );
  }

  let release;
  try {
    release = JSON.parse(response);
  } catch {
    throw new Error("GitHub release response is not valid JSON.");
  }
  if (
    release === null ||
    typeof release !== "object" ||
    Array.isArray(release) ||
    !Array.isArray(release.assets)
  ) {
    throw new Error("GitHub release response must contain an assets array.");
  }
  if (
    !release.assets.every(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        typeof candidate.name === "string" &&
        typeof candidate.state === "string" &&
        typeof candidate.size === "number",
    )
  ) {
    throw new Error("GitHub release response contains an invalid asset.");
  }

  return release.assets.some(
    (candidate) =>
      candidate.name === assetName &&
      candidate.state === "uploaded" &&
      candidate.size > 0,
  )
    ? "complete"
    : "partial";
}

if (require.main === module) {
  try {
    const status = Number(process.argv[2]);
    const assetName = process.argv[3];
    const response = fs.readFileSync(0, "utf8");
    process.stdout.write(`${classifyRelease(status, response, assetName)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { classifyRelease };
