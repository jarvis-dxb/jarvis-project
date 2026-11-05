import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { env } from '../config/env.js';
import { chromium } from 'playwright';
import { EventEmitter } from 'events';

// Data stream ke liye emitter
export const dataFeed = new EventEmitter();

const findChromiumExecutable = () => {
    const candidates = [
        env.CHROMIUM_EXECUTABLE_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate));
};

export async function launchBrowser(baseUrlOrPort = 3000) {
    console.log('[Browser] Launching Headless Instance...');

    const executablePath = findChromiumExecutable();
    const baseUrl = typeof baseUrlOrPort === 'number'
        ? `http://127.0.0.1:${baseUrlOrPort}`
        : String(baseUrlOrPort).replace(/\/$/, '');

    const browser = await chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Memory issues se bachne ke liye
            '--disable-accelerated-2d-canvas',
            '--no-first-run'
        ]
    });

    const context = await browser.newContext();

    // 1. Public folder se saari HTML files ki list nikalen
    const publicDir = path.dirname(env.HTML_PATH);
    const files = fs.readdirSync(publicDir).filter(file => file.endsWith('.html'));

    // const files = ["BTCUSDT.html"]; // for local testing

    console.log(`[Browser] Processing ${files.length} files...`);

    // 1. Processing function banayen jo har file ke liye execute hogi
    const openPage = async (file) => {
        const page = await context.newPage();

        // Browser console handling
        page.on('console', (msg) => {
            // console.log(`[Browser] ${msg.text()}`);
        });
        // Optimize: Resource-heavy cheezon ko block karen (images, css etc. agar zaroorat nahi)
        // Isse page load speed mazeed fast ho jayegi
        await page.route('**/*.{png,jpg,jpeg,gif,svg,css}', (route) => route.abort());

        await page.exposeFunction('emitToBackend', (data) => {
            dataFeed.emit('incoming-data', data);
        });

        // Browser ke andar event listener lagana
        await page.addInitScript(() => {
            window.addEventListener('candleUpdates', (e) => {
                window.emitToBackend(e.detail);
            });
        });

        // URL construct karen (e.g., http://localhost:3000/BTCUSDT.html)
        const fileUrl = `${baseUrl}/${file}`;

        try {
            // use 'domcontentloaded' bcs 'networkidle' kaafi wait karwata hai
            await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            console.log(`${chalk.gray('[Browser]')} Live: ${chalk.green(file)}`);
            return page;
        } catch (err) {
            console.error(`[${file}] Failed: ${err.message}`);
            await page.close();
        }
    };

    // 2. Saari files ko ek saath start karen (Parallelism)
    // Agar files 20-30 se zyada hain, toh batches mein karein varna RAM crash ho sakti hai.
    await Promise.all(files.map(file => openPage(file)));

    console.log('[Browser] All pages are live and streaming data...');

    return {
        browser,
        context
    };
}
