import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { type ProductData } from './llm_processor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PROJECT_ROOT         = path.resolve(__dirname, '../..');
const STORAGE_DIR          = path.join(PROJECT_ROOT, 'storage');
const PROVIDERS_CONFIG_PATH = path.join(PROJECT_ROOT, 'providers.json');
const OUTPUT_DIR           = path.join(PROJECT_ROOT, 'export');
const OUTPUT_FILE          = path.join(OUTPUT_DIR, 'opencart_import.xlsx');

// ─────────────────────────────────────────────────────────────────────────────
// Путь к изображениям на сервере OpenCart
// Файлы заливаются в: <opencart>/image/catalog/products/<slug>/<filename>
// В Excel записываем путь ОТНОСИТЕЛЬНО папки image/:
// ─────────────────────────────────────────────────────────────────────────────
function buildServerImagePath(slug: string, filename: string): string {
  return `catalog/products/${slug}/${filename}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Считать список картинок из папки images/ товара
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

  // Ищем главное фото: main.webp | main.avif | первый файл
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
// Расширенный тип для data.json (ProductData + возможный _partial маркер)
// ─────────────────────────────────────────────────────────────────────────────
type DataJson = Partial<ProductData> & {
  name: string;
  _partial?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Извлечь числовое значение веса
// ─────────────────────────────────────────────────────────────────────────────
function parseWeight(weightStr: string | undefined): number {
  if (!weightStr) return 0;
  const match = weightStr.match(/[\d.,]+/);
  return match ? parseFloat(match[0].replace(',', '.')) : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Точные заголовки для Products (39 колонок, без дубликата model,
// чтобы избежать сдвига колонок при импорте в OpenCart)
// ─────────────────────────────────────────────────────────────────────────────
const PRODUCTS_HEADERS = [
  'product_id',
  'name(uk-ua)',
  'description(uk-ua)',
  'meta_title(uk-ua)',
  'meta_description(uk-ua)',
  'meta_keyword(uk-ua)',
  'tag(uk-ua)',
  'model',
  'sku',
  'upc',
  'ean',
  'jan',
  'isbn',
  'mpn',
  'location',
  'quantity',
  'stock_status_id',
  'image',
  'manufacturer_id',
  'shipping',
  'price',
  'points',
  'tax_class_id',
  'date_available',
  'weight',
  'weight_class_id',
  'length',
  'width',
  'height',
  'length_class_id',
  'status',
  'sort_order',
  'categories',
  'downloads',
  'filters',
  'related',
  'attributes',
  'options',
  'viewed'
];

const ADDITIONAL_IMAGES_HEADERS = ['product_id', 'image', 'sort_order'];
const PRODUCT_ATTRIBUTES_HEADERS = ['product_id', 'attribute_group', 'attribute_name', 'text(uk-ua)'];
const SPECIALS_HEADERS = ['product_id', 'customer_group', 'priority', 'price', 'date_start', 'date_end'];
const DISCOUNTS_HEADERS = ['product_id', 'customer_group', 'quantity', 'priority', 'price', 'date_start', 'date_end'];
const REWARDS_HEADERS = ['product_id', 'customer_group', 'points'];
const PRODUCT_OPTIONS_HEADERS = ['product_id', 'option', 'required'];
const PRODUCT_OPTION_VALUES_HEADERS = [
  'product_id', 'option', 'option_value', 'quantity', 'subtract', 'price', 'price_prefix', 'points', 'points_prefix', 'weight', 'weight_prefix'
];

// ─────────────────────────────────────────────────────────────────────────────
// Главная функция генерации Excel
// ─────────────────────────────────────────────────────────────────────────────
async function run(): Promise<void> {
  // ── Читаем providers.json ─────────────────────────────────────────────────
  if (!fs.existsSync(PROVIDERS_CONFIG_PATH)) {
    console.error(`❌ providers.json не найдено: ${PROVIDERS_CONFIG_PATH}`);
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

  // ── Гарантируем папку export/ ───────────────────────────────────────────────
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const productRows: any[] = [];
  const additionalImageRows: any[] = [];
  const attributeRows: any[] = [];

  let currentProductId = 10001; // автоинкремент для новых товаров
  let totalProducts  = 0;
  let totalSkipped   = 0;
  let totalPartial   = 0;

  for (const [providerKey] of activeProviders) {
    const providerDir = path.join(STORAGE_DIR, providerKey);

    if (!fs.existsSync(providerDir)) {
      console.warn(`⚠️  Папка storage/${providerKey}/ не найдена. Пропускаю.`);
      continue;
    }

    const slugs = fs
      .readdirSync(providerDir)
      .filter(name => fs.statSync(path.join(providerDir, name)).isDirectory());

    console.log(`\n📦 Провайдер: "${providerKey}" — ${slugs.length} папок`);

    for (const slug of slugs) {
      const productDir   = path.join(providerDir, slug);
      const dataJsonPath = path.join(productDir, 'data.json');

      // Пропускаем если data.json отсутствует
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

      const productId = currentProductId++;

      // ── Картинки ─────────────────────────────────────────────────────────
      const { main: mainImage, additional: additionalImages } =
        getProductImages(productDir, slug);

      // ── Вага / размеры ────────────────────────────────────────────────────
      const weightValue = parseWeight(data.weight);

      // Разбираем dimensions вида "163 x 163 x 36 мм"
      let length = 0;
      let width  = 0;
      let height = 0;
      if (data.dimensions) {
        const dimMatch = data.dimensions.match(
          /(\d+[\d.,]*)\s*[xXхХ×]\s*(\d+[\d.,]*)\s*[xXхХ×]\s*(\d+[\d.,]*)/
        );
        if (dimMatch) {
          length = parseFloat(dimMatch[1].replace(',', '.')) || 0;
          width  = parseFloat(dimMatch[2].replace(',', '.')) || 0;
          height = parseFloat(dimMatch[3].replace(',', '.')) || 0;
        }
      }

      const isAvailable = data.in_stock !== false; // по умолчанию true

      // ── Дополнительные фото в AdditionalImages ────────────────────────────
      let sortOrderImg = 0;
      for (const imgPath of additionalImages) {
        additionalImageRows.push([
          productId,
          imgPath,
          sortOrderImg++
        ]);
      }

      // ── Технические характеристики в ProductAttributes ────────────────────
      if (data.attributes && data.attributes.length > 0) {
        for (const attr of data.attributes) {
          attributeRows.push([
            productId,
            attr.group || 'Технічні характеристики',
            attr.name,
            attr.value
          ]);
        }
      }

      // ── Формируем строку Products ─────────────────────────────────────────
      // Порядок колонок соответствует PRODUCTS_HEADERS
      const row = [
        productId,                                                 // product_id
        data.name ?? slug,                                         // name(uk-ua)
        data.description ?? '',                                    // description(uk-ua)
        data.meta_title ?? data.name ?? '',                        // meta_title(uk-ua)
        data.meta_description ?? '',                               // meta_description(uk-ua)
        data.meta_keyword ?? '',                                   // meta_keyword(uk-ua)
        data.tags ?? '',                                           // tag(uk-ua)
        data.model || data.sku || slug,                            // model
        data.sku ?? '',                                            // sku
        '',                                                        // upc
        '',                                                        // ean
        '',                                                        // jan
        '',                                                        // isbn
        '',                                                        // mpn
        '',                                                        // location
        isAvailable ? 100 : 0,                                     // quantity
        7,                                                         // stock_status_id (В наличии)
        mainImage ?? '',                                           // image
        0,                                                         // manufacturer_id
        1,                                                         // shipping
        data.price ?? 0,                                           // price
        0,                                                         // points
        0,                                                         // tax_class_id
        new Date().toISOString().split('T')[0],                     // date_available
        weightValue,                                               // weight
        1,                                                         // weight_class_id (кг)
        length,                                                    // length
        width,                                                     // width
        height,                                                    // height
        1,                                                         // length_class_id (мм)
        1,                                                         // status (включен)
        0,                                                         // sort_order
        data.category ?? '',                                       // categories
        '',                                                        // downloads
        '',                                                        // filters
        '',                                                        // related
        '',                                                        // attributes
        '',                                                        // options
        0                                                          // viewed
      ];

      productRows.push(row);
      totalProducts++;
      console.log(`  ✅ ${slug} -> Product ID ${productId}` + (data._partial ? ' [PARTIAL]' : ''));
    }
  }

  // ── Создаем книгу Excel и листы ───────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  // 1. Products
  const productsWS = XLSX.utils.aoa_to_sheet([PRODUCTS_HEADERS, ...productRows]);
  XLSX.utils.book_append_sheet(wb, productsWS, 'Products');

  // 2. AdditionalImages
  const additionalImagesWS = XLSX.utils.aoa_to_sheet([ADDITIONAL_IMAGES_HEADERS, ...additionalImageRows]);
  XLSX.utils.book_append_sheet(wb, additionalImagesWS, 'AdditionalImages');

  // 3. Specials (пустой)
  const specialsWS = XLSX.utils.aoa_to_sheet([SPECIALS_HEADERS]);
  XLSX.utils.book_append_sheet(wb, specialsWS, 'Specials');

  // 4. Discounts (пустой)
  const discountsWS = XLSX.utils.aoa_to_sheet([DISCOUNTS_HEADERS]);
  XLSX.utils.book_append_sheet(wb, discountsWS, 'Discounts');

  // 5. Rewards (пустой)
  const rewardsWS = XLSX.utils.aoa_to_sheet([REWARDS_HEADERS]);
  XLSX.utils.book_append_sheet(wb, rewardsWS, 'Rewards');

  // 6. ProductAttributes
  const productAttributesWS = XLSX.utils.aoa_to_sheet([PRODUCT_ATTRIBUTES_HEADERS, ...attributeRows]);
  XLSX.utils.book_append_sheet(wb, productAttributesWS, 'ProductAttributes');

  // 7. ProductOptions (пустой)
  const productOptionsWS = XLSX.utils.aoa_to_sheet([PRODUCT_OPTIONS_HEADERS]);
  XLSX.utils.book_append_sheet(wb, productOptionsWS, 'ProductOptions');

  // 8. ProductOptionValues (пустой)
  const productOptionValuesWS = XLSX.utils.aoa_to_sheet([PRODUCT_OPTION_VALUES_HEADERS]);
  XLSX.utils.book_append_sheet(wb, productOptionValuesWS, 'ProductOptionValues');

  // ── Записываем файл XLSX ──────────────────────────────────────────────────
  XLSX.writeFile(wb, OUTPUT_FILE);

  console.log(`
🏁 XLSX Export завершено.
   Файл           : ${OUTPUT_FILE}
   Товарів у XLSX : ${totalProducts}
   Частково       : ${totalPartial}
   Пропущено      : ${totalSkipped}
`);
}

run().catch(err => {
  console.error('💥 Критична помилка:', err);
  process.exit(1);
});
