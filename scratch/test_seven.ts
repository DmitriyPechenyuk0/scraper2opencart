import { chromium } from 'playwright';

async function run() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        console.log('Navigating to seven-systems product list...');
        await page.goto('https://seven-systems.com.ua/ua/product_list', { waitUntil: 'networkidle' });
        
        console.log('Title:', await page.title());
        
        // Find elements with classes related to products
        const productsCount = await page.evaluate(() => {
            return document.querySelectorAll('li[data-qaid="product-block"]').length;
        });
        console.log(`Found li[data-qaid="product-block"]: ${productsCount}`);

        // Let's print out the text of some elements to find "Show more" or pagination buttons
        const elementsText = await page.evaluate(() => {
            const results: string[] = [];
            // Look for buttons, links, etc. that might be pagination
            document.querySelectorAll('a, button').forEach(el => {
                const text = el.textContent?.trim();
                const qaid = el.getAttribute('data-qaid');
                const className = el.className;
                if (text && (text.includes('Показати') || text.includes('ще') || text.includes('Показать') || text.includes('еще') || qaid || className.includes('pagination') || className.includes('more'))) {
                    results.push(`${el.tagName} | text: "${text}" | qaid: "${qaid}" | class: "${className}"`);
                }
            });
            return results;
        });
        
        console.log('Pagination-like elements found:', elementsText);
        
        // Let's print some links that match product page URLs
        const sampleProductLinks = await page.evaluate(() => {
            const links: string[] = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.getAttribute('href');
                if (href && (href.includes('/p') || href.includes('-p'))) {
                    links.push(href);
                }
            });
            return links.slice(0, 10);
        });
        console.log('Sample product links:', sampleProductLinks);
        
    } catch (e: any) {
        console.error('Error:', e);
    } finally {
        await browser.close();
    }
}

run();
