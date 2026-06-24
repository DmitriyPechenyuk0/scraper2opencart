import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function scrape(
    url: string,
    providerKey: string,
    options: { maxPages?: number; maxProducts?: number } = {}
): Promise<void> {
    console.log(`🔎 [${providerKey}] Starting links scraper for: ${url} (options: ${JSON.stringify(options)})`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'uk-UA',
        timezoneId: 'Europe/Kyiv'
    });

    const page = await context.newPage();

    try {
        await page.goto(url, { waitUntil: 'networkidle' });
        
        console.log('📜 Loading all pages using "Показати ще ..." button...');

        let clickCount = 0;
        let prevItemsCount = 0;
        
        while (true) {
            if (options.maxPages && clickCount >= options.maxPages - 1) {
                console.log(`Reached maxPages limit of ${options.maxPages}. Stopping page loads.`);
                break;
            }

            // Scroll to the bottom to make the "Show More" link visible and load images
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(1000);

            // Remove cookie consent banners, fixed overlays, and popup modals that block clicks
            await page.evaluate(() => {
                document.querySelectorAll('.popup-overlay, .popup-modal, .modal-backdrop, .modal, .cky-consent-container, .cky-overlay').forEach(el => el.remove());
                document.body.classList.remove('modal-open');
                document.body.style.overflow = '';
            });

            // Find the "Show More" pagination button/link
            const moreBtn = page.locator('a:has-text("Показати ще ...")').first();
            
            if (await moreBtn.isVisible()) {
                const currentItemsCount = await page.evaluate(() => document.querySelectorAll('.categories__item').length);
                
                // If items count didn't change after a click, we probably reached the end
                if (currentItemsCount === prevItemsCount && clickCount > 0) {
                    console.log('No new items loaded after clicking. All pages loaded!');
                    break;
                }
                prevItemsCount = currentItemsCount;

                console.log(`Found "Показати ще ..." link (current items: ${currentItemsCount}). Clicking...`);
                
                // Use force: true to click in case there are transparent overlays blocking the element
                await moreBtn.click({ force: true });
                clickCount++;

                // Wait for the next items to load/render
                await page.waitForTimeout(2000);
            } else {
                console.log('Link "Показати ще ..." is not visible or not found. All pages loaded!');
                break;
            }
        }

        console.log('⚡ Extracting product URLs from loaded DOM...');

        const urls: string[] = await page.evaluate(() => {
            const links: string[] = [];
            
            document.querySelectorAll('.categories__item a.categories__item-link').forEach(a => {
                const href = a.getAttribute('href');
                if (href) {
                    try {
                        const urlObj = new URL(href, window.location.origin);
                        links.push(urlObj.href);
                    } catch (e) {
                        // Ignore invalid URLs
                    }
                }
            });

            return Array.from(new Set(links));
        });

        let finalUrls = urls;
        if (options.maxProducts && finalUrls.length > options.maxProducts) {
            console.log(`✂️  Limiting product URLs list to ${options.maxProducts} (originally collected ${finalUrls.length})`);
            finalUrls = finalUrls.slice(0, options.maxProducts);
        }

        console.log(`\n📊 [${providerKey}] Successfully collected ${finalUrls.length} product URLs.`);

        // Ensure output folder exists
        const outputDir = path.resolve(__dirname, '../../links_pool');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const outputJsonPath = path.join(outputDir, `${providerKey}_urls.json`);
        fs.writeFileSync(outputJsonPath, JSON.stringify(finalUrls, null, 2), 'utf-8');
        console.log(`✅ [${providerKey}] Saved ${finalUrls.length} links to: ${outputJsonPath}`);

    } catch (error: any) {
        console.error(`💥 Error while scraping ${providerKey}:`, error.message);
        throw error;
    } finally {
        await page.close();
        await browser.close();
    }
}
