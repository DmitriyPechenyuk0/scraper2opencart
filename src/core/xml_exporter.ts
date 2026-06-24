import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'xmlbuilder2';
import { type ProductData } from './llm_processor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PROJECT_ROOT         = path.resolve(__dirname, '../..');
const STORAGE_DIR          = path.join(PROJECT_ROOT, 'storage');
const PROVIDERS_CONFIG_PATH = path.join(PROJECT_ROOT, 'providers.json');
const OUTPUT_DIR           = path.join(PROJECT_ROOT, 'export');
const OUTPUT_FILE          = path.join(OUTPUT_DIR, 'opencart_import.xml');

// ─────────────────────────────────────────────────────────────────────────────
// Шлях до картинок на сервері OpenCart
// Файли заливаються у: <opencart>/image/catalog/products/<slug>/<filename>
// У XML записуємо шлях ВІДНОСНО папки image/:
// ─────────────────────────────────────────────────────────────────────────────
function buildServerImagePath(slug: string, filename: string): string {
  return `catalog/products/${slug}/${filename}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Зчитати список картинок з папки images/ товару
// ─────────────────────────────────────────────────────────────────────────────
function getProductImages(productDir: string, slug: string): {
  main: string | null;
  additional: string[];
} {
  const imagesDir = path.join(productDir, 'images');

  if (!fs.existsSync(imagesDir)) {
    return { main: null, additional: [] };
  }

  const files = fs
    .readdirSync(imagesDir)
    .filter(f => /\.(webp|avif|jpg|jpeg|png)$/i.test(f))
    .sort();

  if (files.length === 0) {
    return { main: null, additional: [] };
  }

  // Шукаємо головне фото: main.webp | main.avif | перший файл
  const mainFile =
    files.find(f => /^main\.(webp|avif)$/i.test(f)) ??
    files[0];

  const additionalFiles = files.filter(f => f !== mainFile);

  return {
    main:       buildServerImagePath(slug, mainFile),
    additional: additionalFiles.map(f => buildServerImagePath(slug, f)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Розширений тип для data.json (ProductData + можливий _partial маркер)
// ─────────────────────────────────────────────────────────────────────────────
type DataJson = Partial<ProductData> & {
  name: string;
  _partial?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Витягнути числове значення ваги (рядок → число)
// ─────────────────────────────────────────────────────────────────────────────
function parseWeight(weightStr: string | undefined): string {
  if (!weightStr) return '';
  const match = weightStr.match(/[\d.,]+/);
  return match ? match[0].replace(',', '.') : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Витягнути числове значення ціни
// ─────────────────────────────────────────────────────────────────────────────
function formatPrice(price: number | undefined): string {
  if (!price || price <= 0) return '0';
  return price.toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Головна функція генерації XML
// ─────────────────────────────────────────────────────────────────────────────
async function run(): Promise<void> {
  // ── Читаємо providers.json ─────────────────────────────────────────────────
  if (!fs.existsSync(PROVIDERS_CONFIG_PATH)) {
    console.error(`❌ providers.json не знайдено: ${PROVIDERS_CONFIG_PATH}`);
    process.exit(1);
  }

  const providers = JSON.parse(
    fs.readFileSync(PROVIDERS_CONFIG_PATH, 'utf-8')
  ) as Record<string, { involved: boolean }>;

  const activeProviders = Object.entries(providers).filter(([, cfg]) => cfg.involved);

  if (activeProviders.length === 0) {
    console.log('Немає активних провайдерів у providers.json. Виходжу.');
    return;
  }

  // ── Гарантуємо папку export/ ───────────────────────────────────────────────
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // ── Ініціалізація XML-документа (формат для Universal Import/Export Pro) ───
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('products');

  let totalProducts  = 0;
  let totalSkipped   = 0;
  let totalPartial   = 0;

  for (const [providerKey] of activeProviders) {
    const providerDir = path.join(STORAGE_DIR, providerKey);

    if (!fs.existsSync(providerDir)) {
      console.warn(`⚠️  Папка storage/${providerKey}/ не знайдена. Пропускаю.`);
      continue;
    }

    const slugs = fs
      .readdirSync(providerDir)
      .filter(name => fs.statSync(path.join(providerDir, name)).isDirectory());

    console.log(`\n📦 Провайдер: "${providerKey}" — ${slugs.length} папок`);

    for (const slug of slugs) {
      const productDir   = path.join(providerDir, slug);
      const dataJsonPath = path.join(productDir, 'data.json');

      // Пропускаємо якщо data.json відсутній
      if (!fs.existsSync(dataJsonPath)) {
        console.warn(`  ⏭️  Skip (no data.json): ${slug}`);
        totalSkipped++;
        continue;
      }

      let data: DataJson;
      try {
        data = JSON.parse(fs.readFileSync(dataJsonPath, 'utf-8')) as DataJson;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Помилка читання data.json для "${slug}": ${msg}`);
        totalSkipped++;
        continue;
      }

      if (data._partial) {
        totalPartial++;
        console.log(`  ⚠️  [PARTIAL] ${slug}`);
      }

      // ── Картинки ─────────────────────────────────────────────────────────
      const { main: mainImage, additional: additionalImages } =
        getProductImages(productDir, slug);

      // ── Вага / розміри ────────────────────────────────────────────────────
      const weightValue = parseWeight(data.weight);

      // ── Будуємо <product> ─────────────────────────────────────────────────
      const product = root.ele('product');

      // ── Ідентифікатори та статус ──────────────────────────────────────────
      product.ele('sku').txt(data.sku ?? '');
      product.ele('model').txt(data.model || data.sku || slug);  // model обов'язковий в OpenCart
      
      const isAvailable = data.in_stock !== false; // default to true if missing
      product.ele('status').txt('1');
      product.ele('quantity').txt(isAvailable ? '100' : '0');
      product.ele('minimum').txt('1');
      product.ele('subtract').txt('1');
      product.ele('stock_status').txt(isAvailable ? 'В наявності' : 'Немає в наявності');
      product.ele('shipping').txt('1');
      product.ele('date_available').txt(
        new Date().toISOString().split('T')[0]
      );
      product.ele('sort_order').txt('0');

      // ── Ціна ──────────────────────────────────────────────────────────────
      product.ele('price').txt(formatPrice(data.price));

      // ── Назва та SEO ──────────────────────────────────────────────────────
      product.ele('name').txt(data.name ?? slug);
      product.ele('description').dat(data.description ?? '');
      product.ele('meta_title').txt(data.meta_title ?? data.name ?? '');
      product.ele('meta_description').txt(data.meta_description ?? '');
      product.ele('meta_keyword').txt(data.meta_keyword ?? '');
      product.ele('tag').txt(data.tags ?? '');

      // ── SEO URL (slug) ────────────────────────────────────────────────────
      product.ele('seo_url').txt(slug);

      // ── Фізичні параметри ─────────────────────────────────────────────────
      if (weightValue) {
        product.ele('weight').txt(weightValue);
        product.ele('weight_class').txt('кг');
      }

      // Розбираємо dimensions вигляду "163 x 163 x 36 мм"
      if (data.dimensions) {
        const dimMatch = data.dimensions.match(
          /(\d+[\d.,]*)\s*[xXхХ×]\s*(\d+[\d.,]*)\s*[xXхХ×]\s*(\d+[\d.,]*)/
        );
        if (dimMatch) {
          product.ele('length').txt(dimMatch[1].replace(',', '.'));
          product.ele('width').txt(dimMatch[2].replace(',', '.'));
          product.ele('height').txt(dimMatch[3].replace(',', '.'));
          product.ele('length_class').txt('мм');
        }
      }

      // ── Головне фото ──────────────────────────────────────────────────────
      if (mainImage) {
        product.ele('image').txt(mainImage);
      }

      // ── Додаткові фото (плоский формат для Universal Import) ───────────────
      if (additionalImages.length > 0) {
        const images = product.ele('images');
        for (const imgPath of additionalImages) {
          images.ele('image').txt(imgPath);
        }
      }

      // ── Категорія (одна листова, модуль створить батьківські сам) ──────────
      if (data.category) {
        product.ele('category').txt(data.category);
      }

      // ── Технічні характеристики (attributes) ─────────────────────────────
      if (data.attributes && data.attributes.length > 0) {
        const attrs = product.ele('attributes');
        for (const attr of data.attributes) {
          const attrEl = attrs.ele('attribute');
          attrEl.ele('group').txt(attr.group);
          attrEl.ele('name').txt(attr.name);
          attrEl.ele('text').txt(attr.value);
        }
      }

      // ── Провайдер (службова мітка — не імпортується, для трекінгу) ────────
      product.ele('provider').txt(providerKey);

      totalProducts++;
      console.log(`  ✅ ${slug}` + (data._partial ? ' [PARTIAL]' : ''));
    }
  }

  // ── Записуємо XML ─────────────────────────────────────────────────────────
  const xmlString = root.end({ prettyPrint: true });
  fs.writeFileSync(OUTPUT_FILE, xmlString, 'utf-8');

  console.log(`
🏁 XML Export завершено.
   Файл          : ${OUTPUT_FILE}
   Товарів у XML : ${totalProducts}
   Частково      : ${totalPartial}
   Пропущено     : ${totalSkipped}
`);
}

run().catch(err => {
  console.error('💥 Критична помилка:', err);
  process.exit(1);
});
