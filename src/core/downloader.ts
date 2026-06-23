import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, Browser, BrowserContext, Page, Response } from 'playwright';
import sharp from 'sharp';
import type { ProvidersConfig } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const LINKS_POOL_DIR = path.join(PROJECT_ROOT, 'links_pool');
const STORAGE_DIR = path.join(PROJECT_ROOT, 'storage');
const PROVIDERS_CONFIG_PATH = path.join(PROJECT_ROOT, 'providers.json');

// Minimum image size in bytes to skip icons/spacers
const MIN_IMAGE_SIZE = 10_000;

interface Metadata {
  url: string;
  providerKey: string;
  slug: string;
  downloadedAt: string;
  imagesCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extracts slug from a product URL.
 *  e.g. https://ajax.systems/ua/products/starterkit/ → starterkit */
function slugFromUrl(url: string): string {
  return url.replace(/\/$/, '').split('/').pop()!;
}

/** Strips scripts, styles, inline styles, SVGs, header, footer, nav. */
function cleanHtml(rawHtml: string): string {
  return rawHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\s+style="[^"]*"/gi, '')
    .replace(/\s+style='[^']*'/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<link\b[^>]*\/?>/gi, '')
    .replace(/<meta\b[^>]*\/?>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Returns true if the response is a real product image (not SVG, icon, etc.) */
function isProductImage(url: string, contentType: string): boolean {
  if (!contentType.startsWith('image/')) return false;
  if (contentType.includes('svg') || url.includes('.svg')) return false;
  if (/\/(icon|favicon|logo|sprite|badge)/i.test(url)) return false;
  return true;
}

/** Converts an image buffer to WebP and saves it to disk. */
async function saveImageAsWebP(imageBuffer: Buffer, outputPath: string): Promise<boolean> {
  try {
    await sharp(imageBuffer).webp({ quality: 82 }).toFile(outputPath);
    return true;
  } catch (err: any) {
    console.warn(`    ⚠️  Failed to convert image: ${err.message}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scroll helper — triggers lazy-loaded images
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scrolls the page incrementally to the bottom, giving time for lazy images
 * to load on each step. After reaching the bottom waits for networkidle.
 */
async function scrollToBottom(page: Page): Promise<void> {
  const STEP_PX = 600;        // pixels per step
  const STEP_DELAY_MS = 250;  // ms delay between steps

  let lastScrollY = -1;

  while (true) {
    const scrollY: number = await page.evaluate('window.scrollY');
    
    // If scroll position didn't change, we reached the bottom or are stuck
    if (scrollY === lastScrollY) {
      break;
    }
    
    lastScrollY = scrollY;
    await page.evaluate('(step) => window.scrollBy(0, step)', STEP_PX);
    await page.waitForTimeout(STEP_DELAY_MS);
  }

  // Return to top so page.content() is consistent
  await page.evaluate('window.scrollTo(0, 0)');

  // Wait for any remaining lazy requests to finish
  await page.waitForLoadState('networkidle').catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM fallback — collects images not captured via response listener
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queries the DOM for all img[src], img[data-src] and source[srcset] URLs,
 * then fetches them inside the browser context (same cookies/session).
 * Only returns images not already in `alreadySeen`.
 */
async function collectImagesFromDom(
  page: Page,
  alreadySeen: Set<string>
): Promise<Array<{ url: string; buffer: Buffer }>> {
  const imageUrls: string[] = await page.evaluate(`() => {
    const urls = new Set();

    const addUrl = (raw) => {
      if (!raw) return;
      try {
        const abs = new URL(raw, window.location.href).href;
        if (!abs.includes('.svg') && !abs.startsWith('data:')) urls.add(abs);
      } catch {}
    };

    document.querySelectorAll('img').forEach((img) => {
      addUrl(img.src);
      addUrl(img.dataset['src']);
      addUrl(img.dataset['lazySrc']);
    });

    document.querySelectorAll('source[srcset]').forEach((el) => {
      const first = (el.srcset || '').split(',')[0]?.trim().split(' ')[0];
      addUrl(first);
    });

    return Array.from(urls);
  }`);

  const results: Array<{ url: string; buffer: Buffer }> = [];

  for (const imgUrl of imageUrls) {
    if (alreadySeen.has(imgUrl)) continue;

    // Fetch inside the browser so authentication cookies are included
    const base64: string | null = await page.evaluate(`async (url) => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') || '';
        if (!ct.startsWith('image/') || ct.includes('svg')) return null;
        const buf = await res.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
      } catch {
        return null;
      }
    }`, imgUrl);

    if (!base64) continue;

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length >= MIN_IMAGE_SIZE) {
      alreadySeen.add(imgUrl);
      results.push({ url: imgUrl, buffer });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: download a single product
// ─────────────────────────────────────────────────────────────────────────────

async function downloadProduct(
  productUrl: string,
  providerKey: string,
  context: BrowserContext
): Promise<void> {
  const slug = slugFromUrl(productUrl);
  const productDir = path.join(STORAGE_DIR, providerKey, slug);
  const imagesDir  = path.join(productDir, 'images');
  const rawHtmlPath  = path.join(productDir, 'raw_page.html');
  const metadataPath = path.join(productDir, 'metadata.json');

  // Idempotency: skip already-downloaded products
  if (fs.existsSync(rawHtmlPath) && fs.existsSync(metadataPath)) {
    console.log(`  ⏭️  Skipping (already downloaded): ${slug}`);
    return;
  }

  console.log(`  📥 Downloading: ${slug}`);
  fs.mkdirSync(imagesDir, { recursive: true });

  const page: Page = await context.newPage();

  // Network response interceptor — captures images as they load
  const interceptedImages: Array<{ url: string; buffer: Buffer }> = [];
  const seenImageUrls = new Set<string>();

  page.on('response', async (response: Response) => {
    try {
      const url = response.url();
      const ct  = response.headers()['content-type'] || '';
      if (seenImageUrls.has(url) || !isProductImage(url, ct)) return;
      const buffer = await response.body().catch(() => null);
      if (buffer && buffer.length >= MIN_IMAGE_SIZE) {
        seenImageUrls.add(url);
        interceptedImages.push({ url, buffer });
      }
    } catch { /* ignore */ }
  });

  try {
    await page.goto(productUrl, { waitUntil: 'networkidle', timeout: 60_000 });

    // Scroll through the whole page to trigger lazy-loaded images
    console.log(`    🖱️  Scrolling to trigger lazy-load...`);
    await scrollToBottom(page);

    // Small extra wait for any final XHR image requests
    await page.waitForTimeout(1500);

    // DOM fallback for images not captured via the network interceptor
    console.log(`    🔍 Scanning DOM for remaining images...`);
    const domImages = await collectImagesFromDom(page, seenImageUrls);
    const allImages = [...interceptedImages, ...domImages];

    console.log(
      `    📦 ${interceptedImages.length} via network + ${domImages.length} via DOM = ${allImages.length} total`
    );

    // Save all images as WebP
    let mainSaved = false;
    let addIndex  = 1;
    let savedCount = 0;

    for (const img of allImages) {
      const filename = mainSaved ? `add_${addIndex++}.webp` : ((mainSaved = true), 'main.webp');
      const saved = await saveImageAsWebP(img.buffer, path.join(imagesDir, filename));
      if (saved) {
        savedCount++;
        console.log(`    🖼️  ${filename}  (${(img.buffer.length / 1024).toFixed(0)} KB)`);
      }
    }

    if (allImages.length === 0) {
      console.warn(`    ⚠️  No images found for: ${slug}`);
    }

    // Save cleaned HTML
    const cleanedHtml = cleanHtml(await page.content());
    fs.writeFileSync(rawHtmlPath, cleanedHtml, 'utf-8');
    console.log(`    📄 raw_page.html  (${(cleanedHtml.length / 1024).toFixed(1)} KB)`);

    // Save metadata
    const metadata: Metadata = {
      url: productUrl,
      providerKey,
      slug,
      downloadedAt: new Date().toISOString(),
      imagesCount: savedCount,
    };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

  } catch (err: any) {
    console.error(`    💥 Error: ${err.message}`);
    fs.rmSync(productDir, { recursive: true, force: true }); // clean up for retry
    throw err;
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  if (!fs.existsSync(PROVIDERS_CONFIG_PATH)) {
    console.error(`❌ providers.json not found at ${PROVIDERS_CONFIG_PATH}`);
    process.exit(1);
  }

  const providers: ProvidersConfig = JSON.parse(fs.readFileSync(PROVIDERS_CONFIG_PATH, 'utf-8'));
  const activeProviders = Object.entries(providers).filter(([, cfg]) => cfg.involved);

  if (activeProviders.length === 0) {
    console.log('No active providers. Exiting.');
    return;
  }

  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
  });

  try {
    for (const [providerKey] of activeProviders) {
      const linksFile = path.join(LINKS_POOL_DIR, `${providerKey}_urls.json`);

      if (!fs.existsSync(linksFile)) {
        console.warn(`⚠️  Links file not found: ${linksFile}. Run the scraper first!`);
        continue;
      }

      const productUrls: string[] = JSON.parse(fs.readFileSync(linksFile, 'utf-8'));
      console.log(`\n🚀 Provider: ${providerKey} — ${productUrls.length} products`);

      for (let i = 0; i < productUrls.length; i++) {
        const url = productUrls[i];
        console.log(`\n[${i + 1}/${productUrls.length}] ${slugFromUrl(url)}`);
        try {
          await downloadProduct(url, providerKey, context);
        } catch {
          // Already logged; continue with next product
        }
      }

      console.log(`\n✅ Finished: ${providerKey}`);
    }
  } finally {
    await context.close();
    await browser.close();
    console.log('\n🏁 Downloader finished.');
  }
}

run().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
