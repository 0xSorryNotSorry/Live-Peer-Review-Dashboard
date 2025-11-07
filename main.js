import fs from "fs/promises";
import { generatePDF } from "./dataFetcher.js";

// Load configuration from a specified path or default to "config.json"
async function loadConfig(configPath = "./config.json") {
    try {
        const data = await fs.readFile(configPath, "utf8");
        return JSON.parse(data);
    } catch (error) {
        console.error("Error reading config file:", error);
        return [];
    }
}

// Main function to process each PR from config
async function main(configPath) {
    const config = await loadConfig(configPath);

    const repos = config.repositories;

    if (repos.length === 0) {
        console.error("No repositories and pull requests found in config.");
        return;
    }

    await generatePDF(repos, config.name);
}

// Parse command-line arguments
const args = process.argv.slice(2);
let configPath = "./config.json";

args.forEach((arg) => {
    if (arg.startsWith("--config-path=")) {
        configPath = arg.split("=")[1];
    }
});

// Run the main function with the provided config path
main(configPath);
