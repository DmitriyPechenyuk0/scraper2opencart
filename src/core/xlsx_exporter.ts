import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { type ProductData } from './llm_processor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PROJECT_ROOT          = path.resolve(__dirname, '../..');
const STORAGE_DIR           = path.join(PROJECT_ROOT, 'storage');
const PROVIDERS_CONFIG_PATH = path.join(PROJECT_ROOT, 'providers.json');
const OUTPUT_DIR            = path.join(PROJECT_ROOT, 'export');
const OUTPUT_FILE           = path.join(OUTPUT_DIR, 'opencart_import.xlsx');

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
// Транслитерация кириллицы в латиницу для SEO URL
// ─────────────────────────────────────────────────────────────────────────────
function slugify(text: string): string {
  const cyrillicToLatin: Record<string, string> = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ж': 'zh', 'з': 'z',
    'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p',
    'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch',
    'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    'ё': 'yo', 'і': 'i', 'ї': 'yi', 'є': 'ye', 'ґ': 'g'
  };

  return text
    .toLowerCase()
    .split('')
    .map(char => cyrillicToLatin[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Интеллектуальное определение бренда производителя
// ─────────────────────────────────────────────────────────────────────────────
function detectManufacturer(name: string, providerKey: string): string {
  if (providerKey === 'ajax-systems') return 'Ajax';
  if (providerKey === 'seven-systems') return 'SEVEN Systems';
  
  if (!name) return '';
  const firstWord = name.trim().split(/\s+/)[0];
  if (firstWord && /^[a-zA-Zа-яА-ЯёЁіІїЇєЄ]+$/i.test(firstWord)) {
    return firstWord;
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Очистка апострофов в тексте (замена на обычный прямой апостроф ')
// ─────────────────────────────────────────────────────────────────────────────
function cleanApostrophes(text: string): string {
  if (!text) return '';
  
  // Декодируем HTML сущности в прямой модификатор апострофа U+02BC (ʼ)
  // Это предотвращает конвертацию в &apos; библиотекой xlsx и решает проблему с отображением "apos" на сайте
  let cleaned = text
    .replace(/&apos;/g, 'ʼ')
    .replace(/&#39;/g, 'ʼ')
    .replace(/&#039;/g, 'ʼ')
    .replace(/&amp;apos;/g, 'ʼ')
    .replace(/&amp;#39;/g, 'ʼ')
    .replace(/&amp;#039;/g, 'ʼ');

  // Очищаем возможные артефакты "apos", возникшие ранее при некорректной очистке
  cleaned = cleaned.replace(/([а-яА-ЯёЁіІїЇєЄґҐ])\s*apos\s*([а-яА-ЯёЁіІїЇєЄґҐ])/gi, '$1ʼ$2');

  // Разделяем HTML по тегам, чтобы не заменить кавычки в атрибутах тегов
  const parts = cleaned.split(/(<[^>]+>)/g);
  for (let i = 0; i < parts.length; i++) {
    // В текстовых блоках (вне тегов) заменяем любые одиночные кавычки и кривые апострофы на прямой U+02BC (ʼ)
    if (!parts[i].startsWith('<')) {
      parts[i] = parts[i]
        .replace(/'/g, 'ʼ')
        .replace(/`/g, 'ʼ')
        .replace(/’/g, 'ʼ');
    }
  }
  
  return parts.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Рекурсивная очистка всех строковых полей в объекте от неправильных апострофов
// ─────────────────────────────────────────────────────────────────────────────
function cleanObjectApostrophes<T>(obj: T): T {
  if (typeof obj === 'string') {
    return cleanApostrophes(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => cleanObjectApostrophes(item)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const cleaned: any = {};
    for (const key of Object.keys(obj)) {
      cleaned[key] = cleanObjectApostrophes((obj as any)[key]);
    }
    return cleaned as T;
  }
  return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// Расширенный тип для data.json (поддержка двуязычного формата и старого)
// ─────────────────────────────────────────────────────────────────────────────
interface ExtendedProductData {
  // Двуязычные поля
  name_ru?: string;
  name_ua?: string;
  name?: string; // старое поле

  description_ru?: string;
  description_ua?: string;
  description?: string; // старое поле

  meta_title_ru?: string;
  meta_title_ua?: string;
  meta_title?: string; // старое поле

  meta_description_ru?: string;
  meta_description_ua?: string;
  meta_description?: string; // старое поле

  meta_keyword_ru?: string;
  meta_keyword_ua?: string;
  meta_keyword?: string; // старое поле

  tags_ru?: string;
  tags_ua?: string;
  tags?: string; // старое поле

  category_ru?: string;
  category_ua?: string;
  category?: string; // старое поле

  model?: string;
  sku?: string;
  price?: number | string;
  weight?: string;
  dimensions?: string;
  in_stock?: boolean;
  _partial?: boolean;

  attributes?: Array<{
    group_ru?: string;
    group_ua?: string;
    group?: string; // старое поле

    name_ru?: string;
    name_ua?: string;
    name?: string; // старое поле

    value_ru?: string;
    value_ua?: string;
    value?: string; // старое поле
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Извлечь числовое значение веса
// ─────────────────────────────────────────────────────────────────────────────
function parseWeight(weightStr: string | undefined): number {
  if (!weightStr) return 0;
  const match = weightStr.match(/[\d.,]+/);
  return match ? parseFloat(match[0].replace(',', '.')) : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Обернуть описание в HTML-тег для фиксации шрифта Open Sans 13px
// ─────────────────────────────────────────────────────────────────────────────
function wrapDescription(html: string | undefined): string {
  if (!html) return '';
  const trimmed = html.trim();
  const targetPrefix = '<div style="font-family: Open Sans, sans-serif; font-size: 13px; line-height: 1.5;">';
  
  if (trimmed.startsWith(targetPrefix) && trimmed.endsWith('</div>')) {
    return trimmed;
  }
  
  return `${targetPrefix}${trimmed}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Точные заголовки для Products (46 колонок, на основе products-export.xlsx)
// ─────────────────────────────────────────────────────────────────────────────
const PRODUCTS_HEADERS = [
  'product_id',
  'name(ru-ru)',
  'name(uk-ua)',
  'categories',
  'sku',
  'upc',
  'ean',
  'jan',
  'isbn',
  'mpn',
  'location',
  'quantity',
  'model',
  'manufacturer',
  'image_name',
  'shipping',
  'price',
  'points',
  'date_added',
  'date_modified',
  'date_available',
  'weight',
  'weight_unit',
  'length',
  'width',
  'height',
  'length_unit',
  'status',
  'tax_class_id',
  'description(ru-ru)',
  'description(uk-ua)',
  'meta_title(ru-ru)',
  'meta_title(uk-ua)',
  'meta_description(ru-ru)',
  'meta_description(uk-ua)',
  'meta_keywords(ru-ru)',
  'meta_keywords(uk-ua)',
  'stock_status_id',
  'store_ids',
  'layout',
  'related_ids',
  'tags(ru-ru)',
  'tags(uk-ua)',
  'sort_order',
  'subtract',
  'minimum'
];

const ADDITIONAL_IMAGES_HEADERS = ['product_id', 'image', 'sort_order'];

const SPECIALS_HEADERS = ['product_id', 'customer_group', 'priority', 'price', 'date_start', 'date_end'];
const DISCOUNTS_HEADERS = ['product_id', 'customer_group', 'quantity', 'priority', 'price', 'date_start', 'date_end'];
const REWARDS_HEADERS = ['product_id', 'customer_group', 'points'];

const PRODUCT_OPTIONS_HEADERS = ['product_id', 'option', 'default_option_value', 'required'];
const PRODUCT_OPTION_VALUES_HEADERS = [
  'product_id', 'option', 'option_value', 'quantity', 'subtract', 'price', 'price_prefix', 'points', 'points_prefix', 'weight', 'weight_prefix'
];

const PRODUCT_ATTRIBUTES_HEADERS = [
  'product_id',
  'attribute_group',
  'attribute',
  'text(ru-ru)',
  'text(uk-ua)'
];

const PRODUCT_FILTERS_HEADERS = ['product_id', 'filter_group', 'filter'];
const PRODUCT_SEO_KEYWORDS_HEADERS = ['product_id', 'store_id', 'keyword(ru-ru)', 'keyword(uk-ua)'];

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
  const seoKeywordRows: any[] = [];

  let currentProductId = 10001; // автоинкремент для новых товаров
  let totalProducts  = 0;
  let totalSkipped   = 0;
  let totalPartial   = 0;

  // Генерируем фиксированную дату/время
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + 
                  String(now.getMonth() + 1).padStart(2, '0') + '-' + 
                  String(now.getDate()).padStart(2, '0') + ' ' + 
                  String(now.getHours()).padStart(2, '0') + ':' + 
                  String(now.getMinutes()).padStart(2, '0') + ':' + 
                  String(now.getSeconds()).padStart(2, '0');

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

      let data: ExtendedProductData;
      try {
        const rawData = JSON.parse(fs.readFileSync(dataJsonPath, 'utf-8')) as ExtendedProductData;
        data = cleanObjectApostrophes(rawData);
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

      // ── Обработка двуязычных полей с фоллбеками ───────────────────────────
      const nameRu = data.name_ru ?? data.name ?? slug;
      const nameUa = data.name_ua ?? data.name ?? slug;

      const descriptionRu = wrapDescription(data.description_ru ?? data.description ?? '');
      const descriptionUa = wrapDescription(data.description_ua ?? data.description ?? '');

      const metaTitleRu = data.meta_title_ru ?? data.meta_title ?? nameRu;
      const metaTitleUa = data.meta_title_ua ?? data.meta_title ?? nameUa;

      const metaDescriptionRu = data.meta_description_ru ?? data.meta_description ?? '';
      const metaDescriptionUa = data.meta_description_ua ?? data.meta_description ?? '';

      const metaKeywordRu = data.meta_keyword_ru ?? data.meta_keyword ?? '';
      const metaKeywordUa = data.meta_keyword_ua ?? data.meta_keyword ?? '';

      const tagsRu = data.tags_ru ?? data.tags ?? '';
      const tagsUa = data.tags_ua ?? data.tags ?? '';

      const categoryRu = data.category_ru ?? data.category ?? '';
      const categoryUa = data.category_ua ?? data.category ?? '';

      // ── Технические характеристики в ProductAttributes ────────────────────
      if (data.attributes && data.attributes.length > 0) {
        for (const attr of data.attributes) {
          const groupUa = attr.group_ua ?? attr.group ?? 'Технічні характеристики';
          const nameUa  = attr.name_ua ?? attr.name ?? '';
          const textRu  = attr.value_ru ?? attr.value ?? '';
          const textUa  = attr.value_ua ?? attr.value ?? '';

          attributeRows.push([
            productId,
            groupUa,
            nameUa,
            textRu,
            textUa
          ]);
        }
      }

      // ── Генерация SEO URL для ProductSEOKeywords ──────────────────────────
      const seoRu = `${slugify(nameRu)}-ru`;
      const seoUa = `${slugify(nameUa)}-ua`;
      seoKeywordRows.push([
        productId,
        0, // store_id
        seoRu,
        seoUa
      ]);

      // ── Формируем строку Products (ровно 46 колонок, на основе products-export.xlsx)
      const row = [
        productId,                                                 // 1: product_id
        nameRu,                                                    // 2: name(ru-ru)
        nameUa,                                                    // 3: name(uk-ua)
        categoryUa || categoryRu || '',                            // 4: categories
        data.sku ?? '',                                            // 5: sku
        '',                                                        // 6: upc
        '',                                                        // 7: ean
        '',                                                        // 8: jan
        '',                                                        // 9: isbn
        '',                                                        // 10: mpn
        '',                                                        // 11: location
        isAvailable ? 999 : 0,                                     // 12: quantity
        data.model || data.sku || slug,                            // 13: model
        detectManufacturer(nameUa, providerKey),                  // 14: manufacturer
        mainImage ?? '',                                           // 15: image_name
        'true',                                                    // 16: shipping
        data.price ?? 0,                                           // 17: price
        0,                                                         // 18: points
        dateStr,                                                   // 19: date_added
        dateStr,                                                   // 20: date_modified
        dateStr.split(' ')[0],                                     // 21: date_available
        weightValue,                                               // 22: weight
        'kg',                                                      // 23: weight_unit
        length,                                                    // 24: length
        width,                                                     // 25: width
        height,                                                    // 26: height
        'cm',                                                      // 27: length_unit
        'true',                                                    // 28: status
        0,                                                         // 29: tax_class_id
        descriptionRu,                                             // 30: description(ru-ru)
        descriptionUa,                                             // 31: description(uk-ua)
        metaTitleRu,                                               // 32: meta_title(ru-ru)
        metaTitleUa,                                               // 33: meta_title(uk-ua)
        metaDescriptionRu,                                         // 34: meta_description(ru-ru)
        metaDescriptionUa,                                         // 35: meta_description(uk-ua)
        metaKeywordRu,                                             // 36: meta_keywords(ru-ru)
        metaKeywordUa,                                             // 37: meta_keywords(uk-ua)
        7,                                                         // 38: stock_status_id (В наличии)
        '0',                                                       // 39: store_ids
        '',                                                        // 40: layout
        '',                                                        // 41: related_ids
        tagsRu,                                                    // 42: tags(ru-ru)
        tagsUa,                                                    // 43: tags(uk-ua)
        0,                                                         // 44: sort_order
        'true',                                                    // 45: subtract
        1                                                          // 46: minimum
      ];

      productRows.push(row);
      totalProducts++;
      console.log(`  ✅ ${slug} -> Product ID ${productId}` + (data._partial ? ' [PARTIAL]' : ''));
    }
  }

  // ── Создаем книгу Excel и листы ───────────────────────────────────────────
  const wb = XLSX.utils.book_new();

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

  // 6. ProductOptions (пустой)
  const productOptionsWS = XLSX.utils.aoa_to_sheet([PRODUCT_OPTIONS_HEADERS]);
  XLSX.utils.book_append_sheet(wb, productOptionsWS, 'ProductOptions');

  // 7. ProductOptionValues (пустой)
  const productOptionValuesWS = XLSX.utils.aoa_to_sheet([PRODUCT_OPTION_VALUES_HEADERS]);
  XLSX.utils.book_append_sheet(wb, productOptionValuesWS, 'ProductOptionValues');

  // 8. ProductAttributes
  const productAttributesWS = XLSX.utils.aoa_to_sheet([PRODUCT_ATTRIBUTES_HEADERS, ...attributeRows]);
  XLSX.utils.book_append_sheet(wb, productAttributesWS, 'ProductAttributes');

  // 9. ProductFilters (пустой)
  const productFiltersWS = XLSX.utils.aoa_to_sheet([PRODUCT_FILTERS_HEADERS]);
  XLSX.utils.book_append_sheet(wb, productFiltersWS, 'ProductFilters');

  // 10. ProductSEOKeywords
  const productSEOKeywordsWS = XLSX.utils.aoa_to_sheet([PRODUCT_SEO_KEYWORDS_HEADERS, ...seoKeywordRows]);
  XLSX.utils.book_append_sheet(wb, productSEOKeywordsWS, 'ProductSEOKeywords');

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
