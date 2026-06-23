import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const STORAGE_DIR = path.join(PROJECT_ROOT, 'storage');
const PROVIDERS_CONFIG_PATH = path.join(PROJECT_ROOT, 'providers.json');
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const OLLAMA_MODEL = 'qwen2.5:7b';
const MAX_RETRIES = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schema — строгая структура product.json
// Спроектирована по полям OpenCart (oc_product, oc_product_description,
// oc_product_attribute) для дальнейшего XML-экспорта через Universal I/E.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Один атрибут товара.
 * group → oc_attribute_group.name
 * name  → oc_attribute.name
 * value → oc_product_attribute.text
 */
const AttributeSchema = z.object({
  group: z.string().min(1, 'Attribute group cannot be empty'),
  name: z.string().min(1, 'Attribute name cannot be empty'),
  value: z.string().min(1, 'Attribute value cannot be empty'),
});

/**
 * Полная схема товара.
 *
 * Обязательные поля (guaranteed to exist on any product):
 *   name, meta_title, meta_h1, meta_description, meta_keyword, description
 *
 * Необязательные поля (may not exist for every product):
 *   model, sku, tags, weight, dimensions, attributes
 *
 * Поле category — заполняется из фиксированного словаря (см. CATEGORY_MAP ниже).
 * Цена намеренно исключена — заполняется вручную в OpenCart.
 */
export const ProductSchema = z.object({
  // ── Контент (oc_product_description) ──────────────────────────────────────
  name: z
    .string()
    .min(2, 'Product name must be at least 2 characters')
    .max(255, 'Product name must be under 255 characters'),

  description: z
    .string()
    .min(10, 'Description is too short')
    .describe('HTML description of the product. Must contain semantic product info.'),

  // ── SEO мета-данные (генерирует LLM) ──────────────────────────────────────
  meta_title: z
    .string()
    .min(10, 'meta_title too short')
    .max(160, 'meta_title must be under 160 characters'),

  meta_h1: z
    .string()
    .min(5, 'meta_h1 too short')
    .max(120, 'meta_h1 must be under 120 characters')
    .describe('H1 heading for the product page, may differ from name'),

  meta_description: z
    .string()
    .min(50, 'meta_description too short')
    .max(300, 'meta_description must be under 300 characters'),

  meta_keyword: z
    .string()
    .min(3, 'meta_keyword too short')
    .max(255, 'meta_keyword must be under 255 characters')
    .describe('Comma-separated keywords'),

  // ── Теги (oc_product_description.tag) ─────────────────────────────────────
  tags: z
    .string()
    .max(255, 'tags must be under 255 characters')
    .optional()
    .default('')
    .describe('Comma-separated product tags for internal search'),

  // ── Категория (определяется LLM по фиксированному словарю) ────────────────
  category: z
    .string()
    .min(1, 'category cannot be empty')
    .describe('Category path, e.g. "Охоронні системи > Хаби"'),

  // ── Идентификаторы товара (oc_product) ────────────────────────────────────
  model: z
    .string()
    .max(64, 'model must be under 64 characters')
    .optional()
    .default('')
    .describe('Product model number from the manufacturer'),

  sku: z
    .string()
    .max(64, 'sku must be under 64 characters')
    .optional()
    .default('')
    .describe('Stock Keeping Unit identifier'),

  // ── Физические параметры (oc_product) ─────────────────────────────────────
  weight: z
    .string()
    .optional()
    .default('')
    .describe('Product weight with unit, e.g. "0.32 кг". Empty if unknown.'),

  dimensions: z
    .string()
    .optional()
    .default('')
    .describe('Product dimensions LxWxH with unit, e.g. "163 x 163 x 36 мм". Empty if unknown.'),

  // ── Технические характеристики (oc_product_attribute) ─────────────────────
  attributes: z
    .array(AttributeSchema)
    .optional()
    .default([])
    .describe('Technical specifications of the product. Extract ALL available specs from the page.'),
});

// Тип, выводимый из схемы — используется везде в коде
export type ProductData = z.infer<typeof ProductSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Фиксированный словарь категорий
// LLM должна выбрать одну из этих категорий на основе HTML.
// Путь пишется через " > " (пробел-знак-пробел).
// ─────────────────────────────────────────────────────────────────────────────
// TODO: Дополните список категорий под ваш магазин
const ALLOWED_CATEGORIES = [
  'Охоронні системи > Стартові комплекти',
  'Охоронні системи > Хаби',
  'Охоронні системи > Датчики руху',
  'Охоронні системи > Датчики відчинення',
  'Охоронні системи > Датчики скла',
  'Охоронні системи > Датчики вібрації',
  'Охоронні системи > Сирени',
  'Охоронні системи > Брелоки і клавіатури',
  'Охоронні системи > Модулі і розширювачі',
  'Пожежна безпека > Датчики диму',
  'Пожежна безпека > Датчики вогню',
  'Пожежна безпека > Датчики газу',
  'Захист від затоплення > Датчики протікання',
  'Відеоспостереження > Камери',
  'Відеоспостереження > Реєстратори',
  'Автоматизація > Розумний дім',
  'Аксесуари > Кріплення і монтаж',
  'Аксесуари > Блоки живлення',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Системный промпт для LLM
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(): string {
  return `Ти — досвідчений контент-менеджер інтернет-магазину систем безпеки та автоматизації.
Твоя задача — проаналізувати очищений HTML сторінки товару і повернути ЛИШЕ JSON-об'єкт без жодного іншого тексту.

ОБОВ'ЯЗКОВІ ПРАВИЛА:
1. Повертай ТІЛЬКИ JSON, без markdown, без коментарів, без пояснень.
2. Використовуй мову оригінального сайту (якщо сайт українською — пиши українською).
3. description — це HTML з тегами <p>, <ul>, <li>, <strong>. Зроби його інформативним, на основі реальних даних зі сторінки.
4. meta_title — до 160 символів, включає назву і ключове слово.
5. meta_h1 — може відрізнятися від name, має бути природним і містити ключові слова.
6. meta_description — 150–300 символів, заклик до дії + переваги.
7. meta_keyword — 5–10 ключових слів через кому.
8. tags — 3–8 тегів через кому (загальні терміни для пошуку).
9. category — ОБОВ'ЯЗКОВО вибери ОДНУ категорію з наступного списку (точний текст):
${ALLOWED_CATEGORIES.map(c => `   - "${c}"`).join('\n')}
10. model і sku — беги з реальних даних на сторінці (з характеристик або заголовка). Якщо не знайшов — залиш порожнім рядком "".
11. weight і dimensions — рядок з одиницями виміру ("0.32 кг", "163 x 163 x 36 мм"). Якщо не знайшов — "".
12. attributes — ОБОВ'ЯЗКОВО витягни ВСІ технічні характеристики з розділу специфікацій. Кожна характеристика: { "group": "Назва групи", "name": "Назва параметра", "value": "Значення" }.

СТРУКТУРА JSON:
{
  "name": "string (2–255 символів)",
  "description": "string (HTML)",
  "meta_title": "string (10–160 символів)",
  "meta_h1": "string (5–120 символів)",
  "meta_description": "string (50–300 символів)",
  "meta_keyword": "string",
  "tags": "string",
  "category": "string (з дозволеного списку)",
  "model": "string",
  "sku": "string",
  "weight": "string",
  "dimensions": "string",
  "attributes": [{ "group": "string", "name": "string", "value": "string" }]
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama API — відправка запиту
// ─────────────────────────────────────────────────────────────────────────────
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function callOllama(messages: OllamaMessage[]): Promise<string> {
  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      format: 'json',   // Примушує Ollama повернути валідний JSON
      stream: false,
      options: {
        temperature: 0.1,  // Низька температура = менше галюцинацій
        num_predict: 4096, // Достатньо для повного JSON з атрибутами
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama API error ${response.status}: ${text}`);
  }

  const data = await response.json() as { message: { content: string } };
  return data.message.content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Цикл валідації з повторними запитами
// ─────────────────────────────────────────────────────────────────────────────
async function processWithRetry(
  html: string,
  slug: string
): Promise<ProductData> {
  const messages: OllamaMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: `Проаналізуй цей HTML сторінки товару і поверни JSON:\n\n${html}`,
    },
  ];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`    🤖 Ollama request attempt ${attempt}/${MAX_RETRIES}...`);

    /* ── ЗАКОМЕНТОВАНО: розкоментуй коли Ollama налаштована ─────────────────
    let rawResponse: string;
    try {
      rawResponse = await callOllama(messages);
    } catch (err: any) {
      console.error(`    ❌ Ollama request failed: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }

    // Парсинг JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawResponse);
    } catch (parseErr: any) {
      const errMsg = `JSON parse failed: ${parseErr.message}. Raw: ${rawResponse.slice(0, 200)}`;
      console.warn(`    ⚠️  ${errMsg}`);
      if (attempt < MAX_RETRIES) {
        messages.push(
          { role: 'assistant', content: rawResponse },
          {
            role: 'user',
            content: `Ти повернув невалідний JSON. Помилка: ${parseErr.message}. Поверни виправлений JSON без будь-якого тексту навколо нього.`,
          }
        );
        continue;
      }
      throw new Error(errMsg);
    }

    // Валідація Zod
    const result = ProductSchema.safeParse(parsed);
    if (result.success) {
      console.log(`    ✅ Validation passed on attempt ${attempt}`);
      return result.data;
    }

    const zodError = result.error.errors
      .map(e => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');

    console.warn(`    ⚠️  Zod validation failed (attempt ${attempt}):\n${zodError}`);

    if (attempt < MAX_RETRIES) {
      messages.push(
        { role: 'assistant', content: rawResponse },
        {
          role: 'user',
          content: `Ти повернув неправильну структуру даних. Помилки:\n${zodError}\n\nВиправ JSON і поверни ТІЛЬКИ виправлений об'єкт.`,
        }
      );
    } else {
      throw new Error(`Max retries reached. Last Zod errors:\n${zodError}`);
    }
    ── КІНЕЦЬ ЗАКОМЕНТОВАНОГО БЛОКУ ─────────────────────────────────────── */

    // ── ЗАГЛУШКА для тестування без Ollama ───────────────────────────────────
    // Генерує мінімально валідний product.json щоб перевірити пайплайн
    // Видали цей блок після налаштування Ollama ↓
    console.warn(`    ⚠️  [STUB] Ollama not connected — generating placeholder data for: ${slug}`);
    const stubData: ProductData = ProductSchema.parse({
      name: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      description: `<p>Опис товару <strong>${slug}</strong>. Після підключення Ollama тут буде повноцінний опис з характеристиками.</p>`,
      meta_title: `${slug} — купити в інтернет-магазині`,
      meta_h1: `${slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} — характеристики та ціна`,
      meta_description: `Купити ${slug.replace(/-/g, ' ')} в інтернет-магазині. Технічні характеристики, фото та ціна. Доставка по всій Україні.`,
      meta_keyword: `${slug.replace(/-/g, ', ')}, ajax systems, охоронна система`,
      tags: slug.replace(/-/g, ', '),
      category: 'Охоронні системи > Стартові комплекти',
      model: '',
      sku: '',
      weight: '',
      dimensions: '',
      attributes: [],
    });
    return stubData;
    // ── КІНЕЦЬ ЗАГЛУШКИ ───────────────────────────────────────────────────────
  }

  // TypeScript: теоретично недосяжно, але потрібно для типізації
  throw new Error('Unexpected exit from retry loop');
}

// ─────────────────────────────────────────────────────────────────────────────
// Обробка одного товару
// ─────────────────────────────────────────────────────────────────────────────
async function processProduct(
  providerKey: string,
  slug: string
): Promise<void> {
  const productDir = path.join(STORAGE_DIR, providerKey, slug);
  const rawHtmlPath = path.join(productDir, 'raw_page.html');
  const productJsonPath = path.join(productDir, 'product.json');

  // Пропускаємо якщо product.json вже існує
  if (fs.existsSync(productJsonPath)) {
    console.log(`  ⏭️  Skip (already processed): ${slug}`);
    return;
  }

  // Перевірка наявності raw_page.html
  if (!fs.existsSync(rawHtmlPath)) {
    console.warn(`  ⚠️  raw_page.html not found for: ${slug}. Run downloader first.`);
    return;
  }

  console.log(`  🔬 Processing: ${slug}`);

  const html = fs.readFileSync(rawHtmlPath, 'utf-8');

  // Тримаємо HTML в межах контексту моделі (~8k токенів ≈ ~32k символів)
  const MAX_HTML_CHARS = 32_000;
  const truncatedHtml = html.length > MAX_HTML_CHARS
    ? html.slice(0, MAX_HTML_CHARS) + '\n<!-- HTML truncated -->'
    : html;

  try {
    const productData = await processWithRetry(truncatedHtml, slug);
    fs.writeFileSync(productJsonPath, JSON.stringify(productData, null, 2), 'utf-8');
    console.log(`    💾 Saved product.json (${JSON.stringify(productData).length} bytes, ${productData.attributes?.length ?? 0} attributes)`);
  } catch (err: any) {
    console.error(`    💥 Failed to process ${slug}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Головний цикл
// ─────────────────────────────────────────────────────────────────────────────
async function run(): Promise<void> {
  if (!fs.existsSync(PROVIDERS_CONFIG_PATH)) {
    console.error(`❌ providers.json not found at ${PROVIDERS_CONFIG_PATH}`);
    process.exit(1);
  }

  const providers = JSON.parse(fs.readFileSync(PROVIDERS_CONFIG_PATH, 'utf-8')) as Record<
    string,
    { involved: boolean }
  >;

  const activeProviders = Object.entries(providers).filter(([, cfg]) => cfg.involved);

  if (activeProviders.length === 0) {
    console.log('No active providers. Exiting.');
    return;
  }

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const [providerKey] of activeProviders) {
    const providerDir = path.join(STORAGE_DIR, providerKey);

    if (!fs.existsSync(providerDir)) {
      console.warn(`⚠️  Storage directory not found for provider "${providerKey}". Run downloader first.`);
      continue;
    }

    const slugs = fs.readdirSync(providerDir).filter(name => {
      return fs.statSync(path.join(providerDir, name)).isDirectory();
    });

    console.log(`\n🚀 Provider: "${providerKey}" — ${slugs.length} products to process`);

    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      console.log(`\n[${i + 1}/${slugs.length}] ${slug}`);

      const productJsonPath = path.join(STORAGE_DIR, providerKey, slug, 'product.json');
      if (fs.existsSync(productJsonPath)) {
        totalSkipped++;
      }

      try {
        await processProduct(providerKey, slug);
        if (!fs.existsSync(productJsonPath)) {
          // Was not skipped, check if it was created
        }
        totalProcessed++;
      } catch {
        totalFailed++;
      }
    }
  }

  console.log(`
🏁 LLM Processing completed.
   Processed : ${totalProcessed}
   Skipped   : ${totalSkipped}
   Failed    : ${totalFailed}
`);
}

run().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
