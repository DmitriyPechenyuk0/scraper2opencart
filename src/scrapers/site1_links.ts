import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function scrape(url: string, providerKey: string): Promise<void> {
    console.log(`🔎 [${providerKey}] Starting links scraper for: ${url}`);

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
        
        console.log('📜 Loading all pages using "Показати більше" button...');

        let clickCount = 0;
        while (true) {
            // Scroll to the bottom to make the button visible and clickable
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(1000);

            // Remove cookie consent banners and overlays
            await page.evaluate(() => {
                document.querySelectorAll('.cky-consent-container, .cky-overlay').forEach(el => el.remove());
            });

            // Find "Show More" button
            let moreButton = page.locator('button[data-testid="pagination-more-button"]');
            
            // Fallback to text selector if testid is not present
            if (!(await moreButton.isVisible())) {
                moreButton = page.locator('button:has-text("Показати більше")').filter({ visible: true });
            }

            if (await moreButton.isVisible()) {
                if (await moreButton.isDisabled()) {
                    console.log('Button "Показати більше" is disabled. All pages loaded!');
                    break;
                }

                const currentPage = await moreButton.getAttribute('data-page') || 'unknown';
                console.log(`Found "Показати більше" button (current page: ${currentPage}). Clicking...`);
                
                await moreButton.click();
                clickCount++;

                // Wait for the button state/page number to update
                try {
                    await page.waitForFunction(
                        ({ oldPage }) => {
                            const btn = document.querySelector('button[data-testid="pagination-more-button"]') 
                                        || Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Показати більше'));
                            if (!btn) return true;
                            if (btn.hasAttribute('disabled')) return true;
                            const newPage = btn.getAttribute('data-page');
                            return newPage !== oldPage;
                        },
                        { oldPage: currentPage },
                        { timeout: 8000 }
                    );
                } catch (e) {
                    console.log('Timeout waiting for button update. Checking if it was the last page.');
                }
                
                await page.waitForTimeout(1000);
            } else {
                console.log('Button "Показати більше" is not visible or not found. All pages loaded!');
                break;
            }
        }

        console.log('⚡ Extracting product URLs from loaded DOM...');

        const urls: string[] = await page.evaluate(() => {
            const links: string[] = [];
            
            document.querySelectorAll('a').forEach(a => {
                const href = a.getAttribute('href');
                if (href) {
                    try {
                        const urlObj = new URL(href, window.location.origin);
                        const parts = urlObj.pathname.split('/').filter(Boolean);
                        
                        // Check if this is a product page link
                        // E.g., /ua/products/starterkit/ (parts: ['ua', 'products', 'starterkit'])
                        const isProduct = parts.length >= 2 && parts[parts.length - 2] === 'products';
                        
                        if (isProduct) {
                            links.push(urlObj.pathname);
                        }
                    } catch (e) {
                        // Ignore invalid URLs
                    }
                }
            });

            return Array.from(new Set(links)).map(pathname => window.location.origin + pathname);
        });

        // Filter out non-product pages
        const cleanUrls = urls.filter(url => {
            const lower = url.toLowerCase();
            return !lower.includes('/support') && 
                   !lower.includes('/blog') && 
                   !lower.includes('/where-to-buy') && 
                   !lower.includes('/cases');
        });

        console.log(`\n📊 Successfully collected ${cleanUrls.length} products for ${providerKey}`);

        // Ensure output folder exists
        const outputDir = path.resolve(__dirname, '../../links_pool');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const outputJsonPath = path.join(outputDir, `${providerKey}_urls.json`);
        fs.writeFileSync(outputJsonPath, JSON.stringify(cleanUrls, null, 2), 'utf-8');
        console.log(`✅ Saved ${cleanUrls.length} links to: ${outputJsonPath}`);

    } catch (error: any) {
        console.error(`💥 Error while scraping ${providerKey}:`, error.message);
        throw error;
    } finally {
        await page.close();
        await browser.close();
    }
}
