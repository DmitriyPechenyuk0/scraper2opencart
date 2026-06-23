import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { chromium, Browser, BrowserContext, Page, Response } from 'playwright';
import sharp from 'sharp';
import type { ProvidersConfig } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const LINKS_POOL_DIR = path.join(PROJECT_ROOT, 'links_pool');
const STORAGE_DIR = path.join(PROJECT_ROOT, 'storage');
const PROVIDERS_CONFIG_PATH = path.join(PROJECT_ROOT, 'providers.json');

// Minimum image size in bytes to filter out micro-icons, spacers, track pixels
const MIN_IMAGE_SIZE = 10_000;
// Maximum number of product images to save
const MAX_IMAGES = 8;

interface Metadata {
  url: string;
  providerKey: string;
  slug: string;
  downloadedAt: string;
  imagesCount: number;
}

// Helper to calculate MD5 to prevent saving duplicate images
function getMd5(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/** Extracts slug from a product URL.
 *  e.g. https://ajax.systems/ua/products/starterkit/ → starterkit */
function slugFromUrl(url: string): string {
  return url.replace(/\/$/, '').split('/').pop()!;
}

/**
 * Clean HTML for LLM processing by stripping:
 * - Comments, scripts, styles, noscripts
 * - Structural nav, header, footer, aside blocks
 * - SVG elements, metadata links/meta tags
 * - Noisy style/class/id/data-attributes/aria-attributes/onclick attributes
 */
function cleanHtml(rawHtml: string): string {
  let html = rawHtml;

  // 1. Remove comments
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Remove scripts, style, and noscripts
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // 3. Remove typical layout elements
  html = html.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '');
  html = html.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '');
  html = html.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '');
  html = html.replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, '');

  // 4. Strip SVG graphics
  html = html.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '');

  // 5. Remove head metadata elements
  html = html.replace(/<link\b[^>]*\/?>/gi, '');
  html = html.replace(/<meta\b[^>]*\/?>/gi, '');

  // 6. Strip noisy styling/class/attributes to save massive LLM context tokens.
  // Retains essential functional tags like href, src, alt, title, action, method, etc.
  html = html.replace(/\s+(class|id|style|data-[a-zA-Z0-9-]+|aria-[a-zA-Z0-9-]+|onclick|role|tabindex|onload|onerror)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 7. Standardize spacing and reduce empty lines
  html = html.replace(/[ \t]+/g, ' ');
  html = html.replace(/\n\s*\n/g, '\n');
  html = html.replace(/\n{3,}/g, '\n\n');

  return html.trim();
}

/** Strictly checks if a URL is likely to be a real product image asset */
function isLikelyProductImageUrl(url: string): boolean {
  const lower = url.toLowerCase();

  // Must be http/https
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;

  // Ignore SVGs or data URIs
  if (lower.includes('.svg') || lower.startsWith('data:')) return false;

  // Filter out typical UI layout, icon, flag and design elements
  if (/\/(logo|icon|flag|banner|social|marker|pixel|analytics|cookie|theme|assets|css|js|font|countries)/i.test(lower)) {
    return false;
  }

  // Filter out typical UI actions/placeholders
  if (lower.includes('close.png') || lower.includes('search.png') || lower.includes('arrow.png') || lower.includes('close.svg')) {
    return false;
  }

  // Must look like an image extension or be a CDN image
  const hasImageExtension = /\.(jpg|jpeg|png|webp|avif)/i.test(lower);
  const isCdnImage = lower.includes('cdn-img') || lower.includes('upload');

  return hasImageExtension || isCdnImage;
}

/** Determines if a network response looks like a product image */
function isProductImage(url: string, contentType: string): boolean {
  if (!contentType.startsWith('image/')) return false;
  return isLikelyProductImageUrl(url);
}

/** Converts image buffer to compressed WebP */
async function saveImageAsWebP(imageBuffer: Buffer, outputPath: string): Promise<boolean> {
  try {
    await sharp(imageBuffer)
      .rotate() // Auto-rotates using EXIF orientation metadata
      .webp({ quality: 80, effort: 4 })
      .toFile(outputPath);
    return true;
  } catch (err: any) {
    console.warn(`    ⚠️  Failed to convert image: ${err.message}`);
    return false;
  }
}

/**
 * Scrolls the page incrementally to trigger lazy-loaded images.
 * Waits after reaching the bottom for any remaining XHR/fetch image requests.
 */
async function scrollToBottom(page: Page): Promise<void> {
  const STEP_PX = 500;
  const STEP_DELAY_MS = 200;
  let lastScrollY = -1;
  let scrollAttempts = 0;
  const maxAttempts = 150;

  while (scrollAttempts < maxAttempts) {
    const scrollY = await page.evaluate('window.scrollY') as number;
    const maxScroll = await page.evaluate('document.documentElement.scrollHeight - window.innerHeight') as number;

    if (scrollY === lastScrollY || scrollY >= maxScroll) {
      break;
    }

    lastScrollY = scrollY;
    await page.evaluate(`window.scrollBy(0, ${STEP_PX})`);
    await page.waitForTimeout(STEP_DELAY_MS);
    scrollAttempts++;
  }

  // Wait for any lazy-triggered network requests to fire and resolve
  await page.waitForLoadState('networkidle').catch(() => {});

  // Extra wait to give async response handlers time to capture image buffers
  await page.waitForTimeout(2000);

  // Return to top for consistent HTML capture
  await page.evaluate('window.scrollTo(0, 0)');
}

/** Extracts primary/OG images from page metadata & Structured Data (JSON-LD) */
async function getPrimaryImageUrls(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(`(() => {
      const urls = [];

      // 1. og:image
      const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
      if (ogImg) {
        try { urls.push(new URL(ogImg, window.location.href).href); } catch {}
      }

      // 2. twitter:image
      const twImg = document.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
      if (twImg) {
        try { urls.push(new URL(twImg, window.location.href).href); } catch {}
      }

      // 3. Schema.org JSON-LD
      document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
        try {
          const data = JSON.parse(script.textContent || '');

          const extractImages = (obj) => {
            if (!obj) return;
            if (typeof obj === 'string' && (obj.startsWith('http') || obj.startsWith('/'))) {
              try { urls.push(new URL(obj, window.location.href).href); } catch {}
            } else if (Array.isArray(obj)) {
              obj.forEach(extractImages);
            } else if (typeof obj === 'object') {
              if (obj['@type'] === 'Product' || obj['type'] === 'Product') {
                extractImages(obj.image);
              }
              for (const key of Object.keys(obj)) {
                if (key === 'image') {
                  extractImages(obj[key]);
                }
              }
            }
          };

          extractImages(data);
        } catch {}
      });

      return Array.from(new Set(urls));
    })()`) as string[];
  } catch (err: any) {
    console.error(`    ⚠️ Error in getPrimaryImageUrls: ${err.message}`);
    return [];
  }
}

/** Collects all candidate image URLs visible in the DOM */
async function collectImageUrlsFromDom(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(`(() => {
      const urls = new Set();
      const addUrl = (raw) => {
        if (!raw) return;
        try {
          const abs = new URL(raw, window.location.href).href;
          if (!abs.includes('.svg') && !abs.startsWith('data:')) urls.add(abs);
        } catch {}
      };

      document.querySelectorAll('img').forEach((img) => {
        addUrl(img.getAttribute('src'));
        addUrl(img.getAttribute('data-src'));
        addUrl(img.getAttribute('data-lazy-src'));
        addUrl(img.getAttribute('data-original'));
      });

      document.querySelectorAll('source').forEach((el) => {
        const srcset = el.getAttribute('srcset') || '';
        const parts = srcset.split(',');
        for (const part of parts) {
          const url = part.trim().split(/\\s+/)[0];
          addUrl(url);
        }
      });

      return Array.from(urls);
    })()`) as string[];
  } catch (err: any) {
    console.error(`    ⚠️ Error in collectImageUrlsFromDom: ${err.message}`);
    return [];
  }
}

/**
 * Safe image download using Playwright's authenticated request context.
 * This respects the same session cookies and headers as the browser.
 */
async function downloadImage(context: BrowserContext, url: string): Promise<Buffer | null> {
  try {
    const response = await context.request.get(url, { timeout: 15_000 });
    if (response.ok()) {
      const ct = response.headers()['content-type'] || '';
      if (ct.startsWith('image/') && !ct.includes('svg')) {
        const buffer = await response.body();
        if (buffer && buffer.length >= MIN_IMAGE_SIZE) {
          return buffer;
        }
      }
    }
  } catch (err: any) {
    console.warn(`    ⚠️  Failed to fetch image ${url}: ${err.message}`);
  }
  return null;
}

/** Downloads a single product: HTML + images */
async function downloadProduct(
  productUrl: string,
  providerKey: string,
  context: BrowserContext
): Promise<void> {
  const slug = slugFromUrl(productUrl);
  const productDir = path.join(STORAGE_DIR, providerKey, slug);
  const imagesDir = path.join(productDir, 'images');
  const rawHtmlPath = path.join(productDir, 'raw_page.html');
  const metadataPath = path.join(productDir, 'metadata.json');

  // Idempotency: skip already-completed products
  if (fs.existsSync(rawHtmlPath) && fs.existsSync(metadataPath)) {
    console.log(`  Skip (already downloaded): ${slug}`);
    return;
  }

  console.log(`  Downloading: ${slug}`);

  // Clean partial download if exists
  if (fs.existsSync(productDir)) {
    fs.rmSync(productDir, { recursive: true, force: true });
  }
  fs.mkdirSync(imagesDir, { recursive: true });

  const page = await context.newPage();

  // Auto-dismiss dialogs (cookie consent popups, etc.)
  page.on('dialog', async (dialog) => {
    await dialog.dismiss().catch(() => {});
  });

  // ─── Network Interception ────────────────────────────────────────────────────
  // Capture image responses as they stream. We collect Promises so we can await
  // them all after scroll — this is the KEY fix for missing images: the response
  // handler is async, and closing the page early kills in-flight body() calls.
  const interceptedImages: Array<{ url: string; buffer: Buffer }> = [];
  const seenUrls = new Set<string>();
  const pendingBodyReads: Promise<void>[] = [];

  page.on('response', (response: Response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';

    if (seenUrls.has(url) || !isProductImage(url, ct)) return;

    // Mark URL immediately so duplicate responses are ignored
    seenUrls.add(url);

    // Queue the async body read — do NOT await here (event handler is sync)
    const bodyPromise = response.body()
      .then((buffer) => {
        if (buffer && buffer.length >= MIN_IMAGE_SIZE) {
          interceptedImages.push({ url, buffer });
        }
      })
      .catch(() => { /* ignore individual read failures */ });

    pendingBodyReads.push(bodyPromise);
  });

  try {
    await page.goto(productUrl, { waitUntil: 'networkidle', timeout: 60_000 });

    // Scroll to trigger all lazy-loaded images and wait for them to load
    await scrollToBottom(page);

    // ─── CRITICAL: wait for ALL pending body reads to complete ────────────────
    // This ensures every intercepted response has its buffer before we proceed.
    await Promise.allSettled(pendingBodyReads);

    console.log(`    Intercepted images from network: ${interceptedImages.length}`);

    // Extract metadata-based primary image URLs (og:image, JSON-LD)
    const primaryUrls = await getPrimaryImageUrls(page);

    // Extract all remaining candidate URLs from DOM
    const domUrls = await collectImageUrlsFromDom(page);

    // Capture clean HTML before closing the page
    const rawHtml = await page.content();
    const cleanedHtml = cleanHtml(rawHtml);

    // Close page now — all data collected
    await page.close();

    console.log(`    Primary (OG/LD) URLs: ${primaryUrls.length}, DOM candidate URLs: ${domUrls.length}`);

    // ─── Build final image list ───────────────────────────────────────────────
    // Priority: primary (OG/LD) > intercepted-network > DOM fallback download

    const downloadedImages: Array<{ url: string; buffer: Buffer }> = [];

    // 1. Primary URLs first — fetch if not already intercepted
    for (const url of primaryUrls) {
      if (!isLikelyProductImageUrl(url)) continue;
      const intercepted = interceptedImages.find(img => img.url === url);
      if (intercepted) {
        downloadedImages.push(intercepted);
      } else {
        const buffer = await downloadImage(context, url);
        if (buffer) {
          seenUrls.add(url);
          downloadedImages.push({ url, buffer });
        }
      }
    }

    // 2. Add all other intercepted images (not yet in list)
    for (const img of interceptedImages) {
      if (!downloadedImages.some(d => d.url === img.url)) {
        downloadedImages.push(img);
      }
    }

    // 3. DOM fallback: download images not captured via network at all
    for (const url of domUrls) {
      if (!isLikelyProductImageUrl(url)) continue;
      if (seenUrls.has(url)) continue; // already have it
      if (downloadedImages.length >= MAX_IMAGES * 3) break; // avoid flooding

      const buffer = await downloadImage(context, url);
      if (buffer) {
        seenUrls.add(url);
        downloadedImages.push({ url, buffer });
      }
    }

    // ─── De-duplicate by MD5 ─────────────────────────────────────────────────
    const seenMd5s = new Set<string>();
    const uniqueImages: Array<{ url: string; buffer: Buffer }> = [];

    for (const img of downloadedImages) {
      const hash = getMd5(img.buffer);
      if (!seenMd5s.has(hash)) {
        seenMd5s.add(hash);
        uniqueImages.push(img);
      }
    }

    // ─── Sort: primary images first ─────────────────────────────────────────
    const sortedImages: Array<{ url: string; buffer: Buffer }> = [
      ...uniqueImages.filter(img => primaryUrls.includes(img.url)),
      ...uniqueImages.filter(img => !primaryUrls.includes(img.url)),
    ];

    // ─── Save up to MAX_IMAGES images ────────────────────────────────────────
    const imagesToSave = sortedImages.slice(0, MAX_IMAGES);
    let mainSaved = false;
    let addIndex = 1;
    let savedCount = 0;

    for (const img of imagesToSave) {
      const filename = mainSaved ? `add_${addIndex++}.webp` : ((mainSaved = true), 'main.webp');
      const saved = await saveImageAsWebP(img.buffer, path.join(imagesDir, filename));
      if (saved) savedCount++;
    }

    // ─── Persist HTML and metadata ───────────────────────────────────────────
    fs.writeFileSync(rawHtmlPath, cleanedHtml, 'utf-8');

    const metadata: Metadata = {
      url: productUrl,
      providerKey,
      slug,
      downloadedAt: new Date().toISOString(),
      imagesCount: savedCount,
    };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

    console.log(`    ✅ Done! raw_page.html (${(cleanedHtml.length / 1024).toFixed(1)} KB), ${savedCount} WebP images saved`);
    console.log(`       (${uniqueImages.length} unique found, limited to ${MAX_IMAGES} max)`);

  } catch (err: any) {
    console.error(`    💥 Error for ${slug}:`, err.stack || err.message);
    // Clean up incomplete folder so next run retries
    if (fs.existsSync(productDir)) {
      fs.rmSync(productDir, { recursive: true, force: true });
    }
    throw err;
  } finally {
    if (!page.isClosed()) {
      await page.close();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Execution Loop
// ─────────────────────────────────────────────────────────────────────────────

let stopRequested = false;

process.on('SIGINT', () => {
  console.log('\n🛑 SIGINT received. Finishing current product then exiting...');
  stopRequested = true;
});

process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM received. Finishing current product then exiting...');
  stopRequested = true;
});

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
      if (stopRequested) break;

      const linksFile = path.join(LINKS_POOL_DIR, `${providerKey}_urls.json`);
      if (!fs.existsSync(linksFile)) {
        console.warn(`⚠️  Links file not found: ${linksFile}. Run the scraper first!`);
        continue;
      }

      const productUrls: string[] = JSON.parse(fs.readFileSync(linksFile, 'utf-8'));
      console.log(`\n🚀 Provider: "${providerKey}" — ${productUrls.length} products`);

      for (let i = 0; i < productUrls.length; i++) {
        if (stopRequested) {
          console.log('✋ Stopping at user request.');
          break;
        }

        const url = productUrls[i];
        console.log(`\n[${i + 1}/${productUrls.length}] ${slugFromUrl(url)}`);

        try {
          await downloadProduct(url, providerKey, context);
        } catch {
          // Already logged; continue with next product
        }
      }

      console.log(`\n✅ Finished provider: ${providerKey}`);
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
