const { readFileSync, existsSync } = require("fs");
const path = require("path");
const { extractAndSaveJson } = require("./extractor.js");
const { generateAndSaveMarkdown } = require("./generateMarkdown.js");
/**
 * @description Extracts contract deployment data from run-latest.json (foundry broadcast output) and writes to deployments/json/{chainId}.json & deployments/{chainId}.md
 * @usage node index.js {chainId} [scriptName = "Deploy.s.sol"] [--skip-json | -s]
 * @dev
 *  currently only supports TransparentUpgradeableProxy pattern
 *  foundry (https://getfoundry.sh) required
 */
async function main() {
  let [chainId, scriptName, skipJsonFlag] = validateAndExtractInputs();
  let json;
  if (!skipJsonFlag.length) json = await extractAndSaveJson(scriptName, chainId);
  else {
    console.log("Skipping json extraction, using existing json file");
    const recordFilePath = path.join(__dirname, `../../deployments/json/${chainId}.json`);
    if (!existsSync(recordFilePath)) throw new Error(`error: ${recordFilePath} does not exist`);
    json = JSON.parse(readFileSync(recordFilePath, "utf-8"));
  }
  generateAndSaveMarkdown(json);
}

function validateAndExtractInputs() {
  let [chainId, scriptName, skipJsonFlag] = process.argv.slice(2);
  let printUsageAndExit = false;
  if (!(typeof chainId === "string" && ["string", "undefined"].includes(typeof scriptName)) || chainId === "help") {
    if (chainId !== "help") console.log(`error: invalid inputs: ${JSON.stringify({ chainId, scriptName }, null, 0)}\n`);
    printUsageAndExit = true;
  }
  if (typeof skipJsonFlag !== "undefined" && !["--skip-json", "-s"].includes(skipJsonFlag)) {
    console.log(`error: invalid flag: ${JSON.stringify({ skipJsonFlag }, null, 0)}\n`);
    printUsageAndExit = true;
  }
  if (printUsageAndExit) {
    console.log(`usage: node script/utils/extract.js {chainId} [scriptName = "Deploy.s.sol"] [--skip-json | -s]`);
    process.exit(1);
  }
  if (!scriptName?.length) scriptName = "Deploy.s.sol";
  return [chainId, scriptName, skipJsonFlag];
}

main();
