const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ========== ABOUT ==========

/*

Given the latest broadcast file,
Updates the deployment history and latest data for the chain.

Note: Only TransparentUpgradeableProxy by OpenZeppelin is supported at the moment.

*/

async function extractAndSaveJson(scriptName, chainId) {
  console.log("Extracting...");

  // ========== PREPARE FILES ==========

  // For getVersion helper
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8"));
  const rpcUrl = config.defaultRpc[chainId] || process.env.RPC_URL || "http://127.0.0.1:8545";

  // Latest broadcast
  const filePath = path.join(__dirname, `../../broadcast/${scriptName}/${chainId}/run-latest.json`);
  const jsonData = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  // Previously extracted data
  const recordFilePath = path.join(__dirname, `../../deployments/json/${chainId}.json`);
  let recordData;

  // Try to read previously extracted data
  try {
    recordData = JSON.parse(fs.readFileSync(recordFilePath, "utf8"));
  } catch (error) {
    // If the file doesn't exist, create a new JSON
    recordData = {
      chainId: chainId,
      latest: {},
      history: [],
    };
  }

  // Abort if commit processed
  if (recordData.history.length > 0) {
    const latestEntry = recordData.history[recordData.history.length - 1];
    if (latestEntry.commitHash === jsonData.commit) {
      console.error(`Commit ${jsonData.commit} already processed. Aborted.`);
      process.exit(1);
    }
  }

  // Generate Forge artifacts
  prepareArtifacts();

  // ========== UPDATE LATEST ==========

  const upgradeableTemplate = {
    implementation: "",
    address: "",
    proxy: true,
    version: "",
    proxyType: "TransparentUpgradeableProxy",
    deploymentTxn: "",
    proxyAdmin: "",
    input: {},
  };

  const nonUpgradeableTemplate = {
    address: "",
    proxy: false,
    version: "",
    deploymentTxn: "",
    input: {},
  };

  // Filter CREATE transactions
  const createTransactions = jsonData.transactions.filter((transaction) => transaction.transactionType === "CREATE");

  // For history
  const contracts = {};

  // Iterate over transactions
  for (let i = 0; i < createTransactions.length; i++) {
    const currentTransaction = createTransactions[i];
    const contractName = currentTransaction.contractName;

    // ====== TYPE: CONTRACT NOT PROXY =====
    if (contractName !== "TransparentUpgradeableProxy") {
      // Contract exists in latest
      if (recordData.latest.hasOwnProperty(contractName)) {
        const matchedItem = recordData.latest[contractName];

        // The latest is upgradeable
        if (matchedItem.proxy) {
          // CASE: New implementation created
          const upgradeableItem = {
            ...upgradeableTemplate,
            implementation: currentTransaction.contractAddress,
            proxyAdmin: matchedItem.proxyAdmin,
            address: matchedItem.address,
            proxy: true,
            version: (await getVersion(matchedItem.address, rpcUrl)).version,
            proxyType: matchedItem.proxyType,
            deploymentTxn: matchedItem.deploymentTxn,
            input: {
              constructor: matchConstructorInputs(getABI(contractName), currentTransaction.arguments),
              initializationTxn: "TODO",
            },
          };

          // Append it to history item
          contracts[contractName] = upgradeableItem;
          // Update latest item
          let copyOfUpgradeableItem = { ...upgradeableItem };
          delete copyOfUpgradeableItem.input;
          copyOfUpgradeableItem.timestamp = jsonData.timestamp;
          copyOfUpgradeableItem.commitHash = jsonData.commit;
          recordData.latest[contractName] = copyOfUpgradeableItem;
        } else {
          // The latest wasn't upgradeable
          // CASE: Duplicate non-upgradeable contract
          // TODO Allow if newer version.
          console.error(`${contractName} is duplicate non-upgradeable. Aborted.`);
          process.exit(1);
        }
      } else {
        // Contract didn't exist in latest

        // Search for proxy in subsequent transactions
        let proxyFound = false;

        for (let j = i + 1; j < createTransactions.length; j++) {
          const nextTransaction = createTransactions[j];
          // Proxy found
          if (
            nextTransaction.contractName === "TransparentUpgradeableProxy" &&
            nextTransaction.arguments[0] === currentTransaction.contractAddress
          ) {
            // CASE: New upgradeable contract
            const upgradeableItem = {
              ...upgradeableTemplate,
              implementation: currentTransaction.contractAddress,
              proxyAdmin: nextTransaction.additionalContracts[0].address,
              address: nextTransaction.contractAddress,
              proxy: true,
              version: (await getVersion(nextTransaction.contractAddress, rpcUrl)).version,
              proxyType: nextTransaction.contractName,
              deploymentTxn: nextTransaction.hash,
              input: {
                constructor: matchConstructorInputs(getABI(contractName), currentTransaction.arguments),
                initializationTxn: "TODO",
              },
            };

            // Append it to history item
            contracts[contractName] = upgradeableItem;
            // Update latest item
            let copyOfUpgradeableItem = { ...upgradeableItem };
            delete copyOfUpgradeableItem.input;
            copyOfUpgradeableItem.timestamp = jsonData.timestamp;
            copyOfUpgradeableItem.commitHash = jsonData.commit;
            recordData.latest[contractName] = copyOfUpgradeableItem;

            proxyFound = true;
          }
        }
        // Didn't find proxy
        if (!proxyFound) {
          // CASE: New non-upgradeable contract
          const nonUpgradeableItem = {
            ...nonUpgradeableTemplate,
            address: currentTransaction.contractAddress,
            version: (await getVersion(currentTransaction.contractAddress, rpcUrl)).version,
            deploymentTxn: currentTransaction.hash,
            input: { constructor: matchConstructorInputs(getABI(contractName), currentTransaction.arguments) },
          };

          // Append it to history item
          contracts[contractName] = nonUpgradeableItem;
          // Update latest item
          let copyOfNonUpgradeableItem = { ...nonUpgradeableItem };
          delete copyOfNonUpgradeableItem.input;
          copyOfNonUpgradeableItem.timestamp = jsonData.timestamp;
          copyOfNonUpgradeableItem.commitHash = jsonData.commit;
          recordData.latest[contractName] = copyOfNonUpgradeableItem;
        }
      }
    } else {
      // ===== TYPE: PROXY =====
      // Check if proxy has been processed
      for (const contractName in recordData.latest) {
        if (recordData.latest.hasOwnProperty(contractName)) {
          const latestItem = recordData.latest[contractName];
          if (latestItem.address === currentTransaction.contractAddress) {
            // CASE: Proxy done
            break;
          } else {
            // CASE: Unexpected proxy
            console.error(`Unexpected proxy ${currentTransaction.contractAddress}. Aborted.`);
            process.exit(1);
          }
        }
      }
    }
  }

  // ========== APPEND TO HISTORY ==========

  recordData.history.push({ contracts, timestamp: jsonData.timestamp, commitHash: jsonData.commit });

  // ========== SAVE CHANGES ==========

  // Create file if it doesn't exist
  const directoryPath = path.dirname(recordFilePath);
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }

  // Write to file
  fs.writeFileSync(recordFilePath, JSON.stringify(recordData, null, 2), "utf8");

  console.log(`Extraction complete!`);

  return recordData;
}

// ========== HELPERS ==========

// IN: contract address and RPC URL
// OUT: contract version (.version)
async function getVersion(contractAddress, rpcUrl) {
  try {
    return {
      version: execSync(`cast call ${contractAddress} 'version()(string)' --rpc-url ${rpcUrl}`, {
        encoding: "utf-8",
      }).trim(),
    }; // note: update if not using cast
  } catch (e) {
    if (!e.message.includes("execution reverted")) console.log("ERROR", e); // contract does not implement version(), log otherwise
    return { version: undefined };
  }
}

// IN: contract ABI and input values
// OUT: mappings of input names to values
function matchConstructorInputs(abi, inputData) {
  const inputMapping = {};

  const constructorFunc = abi.find((func) => func.type === "constructor");

  if (constructorFunc && inputData) {
    constructorFunc.inputs.forEach((input, index) => {
      inputMapping[input.name] = inputData[index];
    });
  }

  return inputMapping;
}

// IN: contract name
// OUT: contract ABI
function getABI(contractName) {
  const filePath = path.join(__dirname, `../../out/${contractName}.sol/${contractName}.json`);
  const fileData = fs.readFileSync(filePath, "utf8");
  const abi = JSON.parse(fileData).abi;
  return abi;
}

// Note: Ensures contract artifacts are up-to-date.
function prepareArtifacts() {
  console.log(`Preparing artifacts...`);

  execSync("forge clean");
  execSync("forge build");

  console.log(`Artifacts ready. Continuing.`);
}

module.exports = { extractAndSaveJson };
