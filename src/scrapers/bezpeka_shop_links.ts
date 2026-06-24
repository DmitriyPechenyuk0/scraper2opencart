import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Scraper for bezpeka-shop.com catalog.
 * Platform: Magento 2 (Codazon theme).
 *
 * Product item selector : li.item.product.product-item
 * Product link selector  : a.product-item-link
 * Pagination             : Standard Magento URL-based pagination (?p=N).
 *                          The scraper reads the last page number from the toolbar,
 *                          then iterates pages 1..N sequentially.
 */
export async function scrape(
    url: string,
    providerKey: string,
    options: { maxPages?: number; maxProducts?: number } = {}
): Promise<void> {
    console.log(`🔎 [${providerKey}] Starting links scraper for: ${url} (options: ${JSON.stringify(options)})`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'uk-UA',
        timezoneId: 'Europe/Kyiv',
    });

    const page = await context.newPage();
    const allUrls = new Set<string>();

    /**
     * Strips any existing `?p=N` / `&p=N` from a base URL so we can
     * append our own page parameter cleanly.
     */
    function buildPageUrl(baseUrl: string, pageNum: number): string {
        const u = new URL(baseUrl);
        u.searchParams.set('p', String(pageNum));
        return u.href;
    }

    /**
     * Navigate to a given catalog URL and wait until Magento has rendered
     * the product grid via JavaScript.
     *
     * Magento 2 renders `.product-item` elements client-side after the
     * initial HTML shell arrives — so we must wait for them explicitly.
     */
    async function loadPage(targetUrl: string): Promise<void> {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

        // Remove any cookie / popup overlays that could block interactions
        await page.evaluate(() => {
            document
                .querySelectorAll(
                    [
                        '.amgdpr-bar-container',
                        '.cookie-status-message',
                        '.message.cookie',
                        '[data-role="cookie-status"]',
                        '.modal-overlay',
                        '.modals-overlay',
                    ].join(', ')
                )
                .forEach((el) => el.remove());
            document.body.style.overflow = '';
        });

        // Wait for the product grid rendered by JS — up to 30 s
        await page.waitForSelector('li.item.product.product-item', { timeout: 30_000 });
    }

    /**
     * Read the total number of pages from the Magento toolbar pager.
     * Returns 1 if the pager is not present (single-page catalog).
     *
     * Magento pager structure:
     *   .pages-items > li.item > a[href*="?p=N"]
     * The highest numeric value among those links is the last page.
     */
    async function detectTotalPages(): Promise<number> {
        const lastPage = await page.evaluate(() => {
            const links = Array.from(
                document.querySelectorAll<HTMLAnchorElement>('.pages-items a')
            );
            const nums = links
                .map((a) => {
                    const match = a.href.match(/[?&]p=(\d+)/);
                    return match ? parseInt(match[1], 10) : NaN;
                })
                .filter((n) => !isNaN(n));

            return nums.length ? Math.max(...nums) : 1;
        });
        return lastPage;
    }

    /**
     * Collect all product page URLs rendered on the current page.
     * Magento product links use the class `product-item-link`.
     */
    async function collectUrls(): Promise<void> {
        const pageUrls: string[] = await page.evaluate(() => {
            const links: string[] = [];
            document
                .querySelectorAll<HTMLAnchorElement>('a.product-item-link')
                .forEach((a) => {
                    if (a.href) links.push(a.href.split('?')[0]); // strip query params
                });
            return [...new Set(links)];
        });

        for (const u of pageUrls) {
            allUrls.add(u);
        }
    }

    try {
        // ── Page 1 ─────────────────────────────────────────────────────────
        console.log(`📄 [${providerKey}] Loading page 1...`);
        await loadPage(url);

        const totalPages = await detectTotalPages();
        const limitPages = options.maxPages && options.maxPages < totalPages ? options.maxPages : totalPages;
        console.log(`📋 [${providerKey}] Detected ${totalPages} page(s) in the catalog. Scraping up to ${limitPages} page(s).`);

        await collectUrls();
        console.log(
            `  ✔ Page 1 collected (${allUrls.size} unique URLs so far)`
        );

        // ── Pages 2..N ──────────────────────────────────────────────────────
        for (let pageNum = 2; pageNum <= limitPages; pageNum++) {
            const pageUrl = buildPageUrl(url, pageNum);
            console.log(`📄 [${providerKey}] Loading page ${pageNum} / ${limitPages}: ${pageUrl}`);

            try {
                await loadPage(pageUrl);
                const countBefore = allUrls.size;
                await collectUrls();
                const added = allUrls.size - countBefore;
                console.log(
                    `  ✔ Page ${pageNum} collected (+${added} URLs, total: ${allUrls.size})`
                );
            } catch (err: any) {
                console.warn(
                    `  ⚠️  [${providerKey}] Failed to load page ${pageNum}: ${err.message}. Skipping.`
                );
            }

            // Small polite delay between requests
            await page.waitForTimeout(1000);
        }

        // ── Persist results ─────────────────────────────────────────────────
        let urls = Array.from(allUrls);
        if (options.maxProducts && urls.length > options.maxProducts) {
            console.log(`✂️  Limiting product URLs list to ${options.maxProducts} (originally collected ${urls.length})`);
            urls = urls.slice(0, options.maxProducts);
        }
        console.log(`\n📊 [${providerKey}] Successfully collected ${urls.length} product URLs.`);

        const outputDir = path.resolve(__dirname, '../../links_pool');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const outputPath = path.join(outputDir, `${providerKey}_urls.json`);
        fs.writeFileSync(outputPath, JSON.stringify(urls, null, 2), 'utf-8');
        console.log(`✅ [${providerKey}] Saved ${urls.length} links to: ${outputPath}`);
    } catch (error: any) {
        console.error(`💥 [${providerKey}] Error while scraping:`, error.message);
        throw error;
    } finally {
        await page.close();
        await browser.close();
    }
}
