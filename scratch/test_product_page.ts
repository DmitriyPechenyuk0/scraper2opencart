import { chromium } from 'playwright';

async function testUrl(url: string, waitUntil: 'networkidle' | 'load' | 'domcontentloaded' | 'commit') {
  console.log(`\nTesting with waitUntil: "${waitUntil}"...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'uk-UA',
  });
  const page = await context.newPage();
  
  const startTime = Date.now();
  try {
    await page.goto(url, { waitUntil, timeout: 15_000 });
    const duration = Date.now() - startTime;
    console.log(`✅ Succeeded in ${duration}ms!`);
    console.log(`Title: ${await page.title()}`);
    
    // Check if some basic elements are there
    const hasBody = await page.evaluate(() => !!document.body);
    const htmlLength = await page.evaluate(() => document.documentElement.outerHTML.length);
    console.log(`Body exists: ${hasBody}, HTML length: ${htmlLength}`);
  } catch (e: any) {
    const duration = Date.now() - startTime;
    console.log(`❌ Failed/Timed out after ${duration}ms: ${e.message}`);
  } finally {
    await page.close();
    await browser.close();
  }
}

async function run() {
  const url = 'https://www.bezpeka-shop.com/ua/product/dv-340srn-28/';
  await testUrl(url, 'networkidle');
  await testUrl(url, 'load');
  await testUrl(url, 'domcontentloaded');
}

run();
