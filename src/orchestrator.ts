import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProvidersConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
    const configPath = path.resolve(__dirname, '../providers.json');
    if (!fs.existsSync(configPath)) {
        console.error(`Config file not found at ${configPath}`);
        process.exit(1);
    }

    const configContent = fs.readFileSync(configPath, 'utf8');
    const providers: ProvidersConfig = JSON.parse(configContent);

    for (const [key, provider] of Object.entries(providers)) {
        if (!provider.involved) {
            console.log(`Skipping provider "${key}" (involved: false)`);
            continue;
        }

        console.log(`🚀 Running scraper "${provider.scraper}" for provider "${key}" (${provider.url})...`);

        try {
            const scraperFileName = provider.scraper.replace(/\.ts$/, '.js');
            const scraperPath = `./scrapers/${scraperFileName}`;
            const scraperModule = await import(scraperPath);
            
            if (typeof scraperModule.scrape !== 'function') {
                throw new Error(`Scraper module "${provider.scraper}" does not export a "scrape" function.`);
            }

            await scraperModule.scrape(provider.url, key, {
                maxPages: provider.maxPages,
                maxProducts: provider.maxProducts
            });
            console.log(`✅ Completed scraper for provider "${key}"`);
        } catch (error: any) {
            console.error(`💥 Error running scraper for provider "${key}":`, error.stack || error.message);
        }
    }
}

run().catch(console.error);
