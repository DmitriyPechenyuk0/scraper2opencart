import { chromium } from 'playwright';

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'uk-UA',
    });
    const page = await context.newPage();

    try {
        console.log('Navigating...');
        await page.goto('https://www.bezpeka-shop.com/ua/catalog/videokamery_1/', {
            waitUntil: 'networkidle',
            timeout: 60_000,
        });

        console.log('Title:', await page.title());
        console.log('URL:', page.url());

        // Count product cards
        const productSelectors = [
            '.product-item',
            '.catalog-item',
            '.goods-item',
            '[class*="product"]',
            '[class*="catalog"]',
            'li.item',
            '.products-grid li',
            '.catalog__item',
        ];
        for (const sel of productSelectors) {
            const count = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
            if (count > 0) console.log(`  Selector "${sel}": ${count} items`);
        }

        // Find pagination elements
        const paginationInfo = await page.evaluate(() => {
            const results: string[] = [];
            document.querySelectorAll('a, button').forEach(el => {
                const text = el.textContent?.trim() || '';
                const cls = el.className || '';
                const href = (el as HTMLAnchorElement).href || '';
                const qaid = el.getAttribute('data-qaid') || '';
                if (
                    text.includes('Показати') || text.includes('ще') ||
                    text.includes('Наступна') || text.includes('Далі') ||
                    text.includes('Next') || text.includes('більше') ||
                    cls.includes('paginat') || cls.includes('next') || cls.includes('more') ||
                    qaid
                ) {
                    results.push(`${el.tagName} | text="${text}" | class="${cls}" | href="${href}" | qaid="${qaid}"`);
                }
            });
            return results.slice(0, 30);
        });
        console.log('\nPagination-like elements:');
        paginationInfo.forEach(l => console.log(' ', l));

        // Get a sample of product links
        const sampleLinks = await page.evaluate(() => {
            const links: string[] = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.href || '';
                if (href && href.includes('bezpeka-shop') && !href.includes('/catalog/')) {
                    links.push(href);
                }
            });
            return [...new Set(links)].slice(0, 15);
        });
        console.log('\nSample non-catalog links (potential product URLs):');
        sampleLinks.forEach(l => console.log(' ', l));

        // Get full list of links with /ua/ in path
        const uaLinks = await page.evaluate(() => {
            const links: string[] = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.href || '';
                if (href && href.includes('/ua/') && href.includes('bezpeka-shop')) {
                    links.push(href);
                }
            });
            return [...new Set(links)].slice(0, 20);
        });
        console.log('\nAll /ua/ links (first 20):');
        uaLinks.forEach(l => console.log(' ', l));

        // Print first product card HTML snippet
        const firstCard = await page.evaluate(() => {
            const cards = document.querySelectorAll('[class*="product"], [class*="catalog-item"], .item');
            for (const c of Array.from(cards)) {
                if (c.textContent && c.textContent.trim().length > 20) {
                    return c.outerHTML.slice(0, 800);
                }
            }
            return 'no card found';
        });
        console.log('\nFirst product card HTML snippet:\n', firstCard);

    } catch (e: any) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
    }
}

run();
