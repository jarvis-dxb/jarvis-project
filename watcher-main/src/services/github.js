import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import axios from 'axios';
import { env } from '../config/env.js';

const log = (msg) => console.log(msg);

// Latest Commit Hash fetch karna
async function getLatestCommitHash() {
    try {
        const { data } = await axios.get(
            `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/commits/main`,
            {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `Bearer ${env.GH_TOKEN}`
                }
            }
        );
        return data.sha;
    } catch (err) {
        log(`${chalk.red('[GitHub]')} Failed to get latest hash, falling back to main.`);
        return 'main';
    }
}

// Directory contents fetch karna
async function getDirectoryContents(dirPath) {
    try {
        const { data } = await axios.get(
            `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${dirPath}?ref=main`,
            {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `Bearer ${env.GH_TOKEN}`
                }
            }
        );
        // Sirf files filter kar rahe hain (directories ko skip karne ke liye)
        return data.filter(item => item.type === 'file');
    } catch (err) {
        console.error(`${chalk.red('[GitHub]')} Failed to list directory:`, err.message);
        return [];
    }
}

// Single file download function (for parallel execution)
async function downloadFile(file, commitHash, targetFolder) {
    const filePath = path.join(targetFolder, file.name);
    const downloadUrl = `https://cdn.jsdelivr.net/gh/${env.GITHUB_OWNER}/${env.GITHUB_REPO}@${commitHash}/${file.path}`;

    try {
        const { data: content } = await axios.get(`${downloadUrl}?t=${Date.now()}`);
        fs.writeFileSync(filePath, content, 'utf8');
        return true;
    } catch (err) {
        log(`${chalk.red('[Error]')} Failed: ${file.name} -> ${err.message}`);
        return false;
    }
}

async function syncGithubContent() {
    try {
        const symbolsDir = '3/webapp/symbols';

        // Base public path (e.g., ./public/)
        const targetFolder = path.dirname(env.HTML_PATH);

        // Latest Hash lein taake cache ka masla na ho
        const commitHash = await getLatestCommitHash();
        log(`${chalk.magenta('[GitHub]')} Latest Commit: ${chalk.dim(commitHash)}`);

        //  Cleanup
        if (!fs.existsSync(targetFolder)) {
            fs.mkdirSync(targetFolder, { recursive: true });
        } else {
            // Delete existing files before sync
            const existingFiles = fs.readdirSync(targetFolder);

            for (const file of existingFiles) {
                const fullPath = path.join(targetFolder, file);
                // Sirf files delete karein, directories ko chorr dein (safe side)
                if (fs.lstatSync(fullPath).isFile()) {
                    fs.unlinkSync(fullPath);
                }
            }
        }

        // Fetch latest files from GitHub

        const files = await getDirectoryContents(symbolsDir);

        if (files.length === 0) return;

        log(`${chalk.yellow('[GitHub]')} Downloading...`);

        // Saari files ek saath download start kar rahe hain
        const downloadPromises = files.map(file => downloadFile(file, commitHash, targetFolder));

        // Wait for all downloads to finish
        await Promise.all(downloadPromises);
        // --- SPEED IMPROVEMENT END ---
        log(`${chalk.cyan('[GitHub]')} Total ${files.length} files downloaded.`);

    } catch (err) {
        console.error(`${chalk.red('[GitHub]')} Sync failed:`, err.message);
    }
}

export { syncGithubContent };