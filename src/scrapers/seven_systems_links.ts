import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Scraper for seven-systems.com.ua catalog.
 * The site is hosted on the Prom.ua platform.
 *
 * Product item selector : li[data-qaid="product-block"]
 * Product link selector  : a.b-product-gallery__image-link  (href="/ua/p{id}-{slug}.html")
 * Pagination             : "Показати ще" button (Prom.ua standard)
 */
export async function scrape(url: string, providerKey: string): Promise<void> {
    console.log(`🔎 [${providerKey}] Starting links scraper for: ${url}`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'uk-UA',
        timezoneId: 'Europe/Kyiv',
    });

    const page = await context.newPage();

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });

        console.log(`📜 [${providerKey}] Expanding catalog via "Показати ще" button...`);

        let clickCount = 0;
        let prevProductCount = 0;
        const MAX_STALL_ATTEMPTS = 3;
        let stallAttempts = 0;

        while (true) {
            // Scroll to the very bottom so the "Show more" button enters the viewport
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(1200);

            // Remove any overlay/cookie banners that may block clicks (Prom.ua style)
            await page.evaluate(() => {
                document
                    .querySelectorAll(
                        [
                            '.js-modal-overlay',
                            '.modal-overlay',
                            '.cky-consent-container',
                            '.cky-overlay',
                            '[data-qaid="cookie_notice"]',
                            '.b-cookies-notice',
                        ].join(', ')
                    )
                    .forEach((el) => el.remove());
                document.body.style.overflow = '';
            });

            // ── Try to locate the "Показати ще" control ──────────────────────
            // Prom.ua renders it as:  <a data-qaid="next_page">Показати ще</a>
            // Fallback: any <a> or <button> containing the text
            let moreBtn = page.locator('[data-qaid="next_page"]').first();

            if (!(await moreBtn.isVisible())) {
                moreBtn = page
                    .locator('a:has-text("Показати ще"), button:has-text("Показати ще")')
                    .first();
            }

            if (!(await moreBtn.isVisible())) {
                console.log(
                    `ℹ️  [${providerKey}] "Показати ще" not visible — all products loaded.`
                );
                break;
            }

            // Guard against infinite loops when count doesn't grow
            const currentCount = await page.evaluate(
                () => document.querySelectorAll('li[data-qaid="product-block"]').length
            );

            if (currentCount === prevProductCount) {
                stallAttempts++;
                if (stallAttempts >= MAX_STALL_ATTEMPTS) {
                    console.log(
                        `⚠️  [${providerKey}] Product count stalled at ${currentCount} for ${stallAttempts} attempts — stopping.`
                    );
                    break;
                }
            } else {
                stallAttempts = 0;
                prevProductCount = currentCount;
            }

            console.log(
                `🖱️  [${providerKey}] Clicking "Показати ще" (click #${clickCount + 1}, products so far: ${currentCount})...`
            );

            await moreBtn.click({ force: true });
            clickCount++;

            // Wait for new product cards to appear in the DOM
            try {
                await page.waitForFunction(
                    (prevCount: number) =>
                        document.querySelectorAll('li[data-qaid="product-block"]').length >
                        prevCount,
                    currentCount,
                    { timeout: 10_000 }
                );
            } catch {
                console.log(
                    `⏳ [${providerKey}] Timeout waiting for new products after click #${clickCount}. Rechecking...`
                );
            }

            await page.waitForTimeout(800);
        }

        // ── Extract all product URLs ─────────────────────────────────────────
        console.log(`⚡ [${providerKey}] Extracting product URLs from the loaded DOM...`);

        const urls: string[] = await page.evaluate(() => {
            const seen = new Set<string>();
            const results: string[] = [];

            /**
             * Each product card  li[data-qaid="product-block"] contains two links
             * to the product page:
             *   • a.b-product-gallery__image-link  (image anchor)
             *   • a.b-goods-title                  (title anchor)
             *
             * Both share the same href, e.g. /ua/p1434161998-nabor-radiobrelka-sht.html
             * We take .b-product-gallery__image-link as the primary selector.
             */
            document
                .querySelectorAll<HTMLAnchorElement>(
                    'li[data-qaid="product-block"] a.b-product-gallery__image-link'
                )
                .forEach((a) => {
                    const href = a.getAttribute('href');
                    if (!href) return;

                    try {
                        const full = new URL(href, window.location.origin).href;
                        if (!seen.has(full)) {
                            seen.add(full);
                            results.push(full);
                        }
                    } catch {
                        // skip malformed hrefs
                    }
                });

            return results;
        });

        console.log(`\n📊 [${providerKey}] Successfully collected ${urls.length} product URLs.`);

        // ── Persist results ──────────────────────────────────────────────────
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
