import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const STORAGE_DIR = path.join(PROJECT_ROOT, 'storage');
const PROVIDERS_CONFIG_PATH = path.join(PROJECT_ROOT, 'providers.json');

// ─── llama.cpp server (OpenAI-compatible API) ────────────────────────────────
const LLAMA_URL = 'http://127.0.0.1:8080/v1/chat/completions';
// Модель: llama.cpp не требует имени — передаём произвольную строку.
// Если нужна конкретная — поменяй ниже.
const LLAMA_MODEL = 'local-model';
const MAX_RETRIES = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schema — строгая структура data.json
//
// Обязательные поля: name, description, meta_title, meta_h1,
//                    meta_description, meta_keyword
// Остальные — optional / default(''). Если LLM не нашла данные — оставляет
// пустую строку или пустой массив, и скрипт сохраняет то, что есть.
// ─────────────────────────────────────────────────────────────────────────────
const AttributeSchema = z.object({
  group: z.string().min(1),
  name:  z.string().min(1),
  value: z.string().min(1),
});

export const ProductSchema = z.object({
  // ── Контент ───────────────────────────────────────────────────────────────
  name: z.string().min(2).max(255),

  description: z
    .string()
    .min(10)
    .describe('HTML description. Must contain semantic product info.'),

  // ── SEO ───────────────────────────────────────────────────────────────────
  meta_title: z.string().min(10).max(160),

  meta_description: z.string().min(50).max(300),

  meta_keyword: z
    .string()
    .min(3)
    .max(255)
    .describe('Comma-separated keywords'),

  // ── Теги ──────────────────────────────────────────────────────────────────
  tags: z.string().max(255).optional().default(''),

  // ── Категорія ─────────────────────────────────────────────────────────────
  category: z.string().min(1),

  // ── Ідентифікатори ────────────────────────────────────────────────────────
  model: z.string().max(64).optional().default(''),
  sku:   z.string().max(64).optional().default(''),

  // ── Ціна (oc_product.price) ───────────────────────────────────────────────
  price: z.number().min(0).optional().default(0),

  // ── Фізичні параметри ─────────────────────────────────────────────────────
  weight:     z.string().optional().default(''),
  dimensions: z.string().optional().default(''),

  // ── Технічні характеристики ───────────────────────────────────────────────
  attributes: z.array(AttributeSchema).optional().default([]),

  // ── Наявність ──────────────────────────────────────────────────────────────
  in_stock: z.boolean().optional().default(true),
});

export type ProductData = z.infer<typeof ProductSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Схема для «часткового» збереження: те саме, але обов'язкові поля
// послаблені — якщо на сторінці мало даних, зберігаємо всё що є.
// ─────────────────────────────────────────────────────────────────────────────
const PartialProductSchema = ProductSchema.partial({
  description:      true,
  meta_title:       true,
  meta_description: true,
  meta_keyword:     true,
  category:         true,
}).extend({
  _partial: z.literal(true).optional(),  // маркер часткового запису
});

export type PartialProductData = z.infer<typeof PartialProductSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Фіксований словник категорій
// ─────────────────────────────────────────────────────────────────────────────
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
// Системний промпт
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(): string {
  return `Ти — досвідчений контент-менеджер інтернет-магазину систем безпеки та відеоспостереження.
Твоя задача — проаналізувати очищений HTML сторінки товару і повернути ТІЛЬКИ JSON-об'єкт без будь-якого іншого тексту.

ОБОВ'ЯЗКОВІ ПРАВИЛА:
1. Повертай ТІЛЬКИ валідний JSON. Без markdown-обгортки, без коментарів, без пояснень.
2. Використовуй мову оригінального сайту (якщо сайт українською — пиши українською).
3. Якщо якоїсь інформації немає на сторінці — залишай поле порожнім рядком "", числове поле — 0, масив — [].
4. НЕ вигадуй дані яких немає на сторінці.
5. description — HTML з тегами <p>, <ul>, <li>, <strong>. Інформативний, на основі реальних даних.
6. meta_title — до 160 символів, включає назву і ключове слово.
7. meta_description — 150–300 символів, заклик до дії + переваги.
8. meta_keyword — 5–10 ключових слів через кому.
9. tags — 3–8 тегів через кому.
10. category — ОБОВ'ЯЗКОВО вибери ОДНУ категорію з наступного списку (точний текст):
${ALLOWED_CATEGORIES.map(c => `   - "${c}"`).join('\n')}
11. model і sku — з реальних даних на сторінці. Якщо не знайшов — "".
12. price — числова ціна товару в гривнях (тільки число, без валюти). Якщо ціни немає — 0.
13. weight — рядок з одиницями ("0.32 кг"). Якщо не знайшов — "".
14. dimensions — рядок LxWxH з одиницями ("163 x 163 x 36 мм"). Якщо не знайшов — "".
15. attributes — витягни ВСІ технічні характеристики. Якщо їх немає — [].
16. in_stock — логічне значення (true/false). Поверни true якщо товар є в наявності (наприклад, "В наявності", "Є на складі", "Купити", "Додати до кошика"), поверни false якщо товару немає (наприклад, "Немає в наявності", "Закінчився", "Немає на складі", "Повідомити про наявність").

СТРУКТУРА JSON:
{
  "name": "string (2–255 символів)",
  "description": "string (HTML)",
  "meta_title": "string (10–160 символів)",
  "meta_description": "string (50–300 символів)",
  "meta_keyword": "string",
  "tags": "string",
  "category": "string (з дозволеного списку вище)",
  "model": "string",
  "sku": "string",
  "price": 0,
  "weight": "string",
  "dimensions": "string",
  "attributes": [{ "group": "string", "name": "string", "value": "string" }],
  "in_stock": true
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// llama.cpp API (OpenAI-compatible /v1/chat/completions)
// ─────────────────────────────────────────────────────────────────────────────
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function callLlama(messages: ChatMessage[]): Promise<string> {
  const response = await fetch(LLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLAMA_MODEL,
      messages,
      response_format: { type: 'json_object' }, // гарантує JSON-відповідь
      stream: false,
      temperature: 0.1,   // мінімум галюцинацій
      max_tokens: 8192,   // достатньо для великих товарів з 25+ атрибутами
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`llama.cpp API error ${response.status}: ${text}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('llama.cpp returned empty response content');
  }
  return content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Витягнути JSON навіть якщо LLM обгорнула у markdown-блок
// ─────────────────────────────────────────────────────────────────────────────
function extractJson(raw: string): string {
  // Прибираємо ```json ... ``` або ``` ... ```
  const mdMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (mdMatch) return mdMatch[1];

  // Якщо є просто { ... } — беремо першу та останню фігурну дужку
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return raw.slice(start, end + 1);
  }

  return raw.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Цикл валідації з повторними запитами
// Якщо після MAX_RETRIES повна схема не проходить — зберігаємо частковий запис
// ─────────────────────────────────────────────────────────────────────────────
async function processWithRetry(
  html: string,
  slug: string
): Promise<ProductData | PartialProductData> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: `Проаналізуй цей HTML сторінки товару і поверни JSON:\n\n${html}`,
    },
  ];

  let lastParsed: unknown = null;
  let lastRaw    = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`    🤖 llama.cpp запит ${attempt}/${MAX_RETRIES}...`);

    let rawResponse: string;
    try {
      rawResponse = await callLlama(messages);
      lastRaw = rawResponse;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    ❌ Помилка запиту: ${msg}`);
      if (attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }

    // ── Парсинг JSON ──────────────────────────────────────────────────────
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(rawResponse));
      lastParsed = parsed;
    } catch (parseErr: unknown) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      console.warn(`    ⚠️  JSON parse error: ${msg}`);
      console.warn(`    Raw preview: ${rawResponse.slice(0, 300)}`);

      if (attempt < MAX_RETRIES) {
        messages.push(
          { role: 'assistant', content: rawResponse },
          {
            role: 'user',
            content: `Ти повернув невалідний JSON. Помилка парсингу: ${msg}.\nПоверни ТІЛЬКИ виправлений JSON-об'єкт без будь-якого тексту навколо.`,
          }
        );
        continue;
      }
      // Перед кидком помилки — спробуємо частковий запис
      break;
    }

    // ── Zod валідація — повна схема ───────────────────────────────────────
    const fullResult = ProductSchema.safeParse(parsed);
    if (fullResult.success) {
      console.log(`    ✅ Валідація пройшла (спроба ${attempt})`);
      return fullResult.data;
    }

    const zodErrors = fullResult.error.errors
      .map(e => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');

    console.warn(`    ⚠️  Zod помилки (спроба ${attempt}):\n${zodErrors}`);

    if (attempt < MAX_RETRIES) {
      messages.push(
        { role: 'assistant', content: rawResponse },
        {
          role: 'user',
          content: `Ти повернув неправильну структуру даних. Помилки:\n${zodErrors}\n\nВиправ JSON і поверни ТІЛЬКИ виправлений об'єкт.`,
        }
      );
    }
  }

  // ── Часткове збереження: якщо хоч щось спарсилось ────────────────────────
  if (lastParsed !== null) {
    const partialResult = PartialProductSchema.safeParse({
      ...(lastParsed as object),
      _partial: true,
    });
    if (partialResult.success) {
      console.warn(
        `    ⚠️  [PARTIAL] Збережено частковий data.json для "${slug}". ` +
        `Деякі поля відсутні — перевірте вручну.`
      );
      return partialResult.data;
    }
  }

  throw new Error(
    `Не вдалося отримати валідний JSON від llama.cpp для "${slug}" після ${MAX_RETRIES} спроб. ` +
    `Raw preview: ${lastRaw.slice(0, 500)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Обробка одного товару
// ─────────────────────────────────────────────────────────────────────────────
async function processProduct(providerKey: string, slug: string): Promise<void> {
  const productDir  = path.join(STORAGE_DIR, providerKey, slug);
  const rawHtmlPath = path.join(productDir, 'raw_page.html');
  const dataJsonPath = path.join(productDir, 'data.json');

  // Пропускаємо якщо data.json вже існує і НЕ є частковим записом
  if (fs.existsSync(dataJsonPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(dataJsonPath, 'utf-8')) as { _partial?: boolean };
      if (!existing._partial) {
        console.log(`  ⏭️  Skip (already processed): ${slug}`);
        return;
      }
      console.log(`  🔄 Retry partial: ${slug}`);
    } catch {
      // Якщо файл пошкоджений — переробимо
    }
  }

  if (!fs.existsSync(rawHtmlPath)) {
    console.warn(`  ⚠️  raw_page.html не знайдено для: ${slug}. Спочатку запустіть downloader.`);
    return;
  }

  console.log(`  🔬 Обробка: ${slug}`);

  const html = fs.readFileSync(rawHtmlPath, 'utf-8');

  // Тримаємо HTML в межах контексту моделі (~8k токенів ≈ ~32k символів)
  const MAX_HTML_CHARS = 32_000;
  const truncatedHtml = html.length > MAX_HTML_CHARS
    ? html.slice(0, MAX_HTML_CHARS) + '\n<!-- HTML truncated -->'
    : html;

  try {
    const productData = await processWithRetry(truncatedHtml, slug);
    fs.writeFileSync(dataJsonPath, JSON.stringify(productData, null, 2), 'utf-8');

    const isPartial = '_partial' in productData && productData._partial;
    const attrCount = 'attributes' in productData ? (productData.attributes?.length ?? 0) : 0;
    console.log(
      `    💾 Saved data.json` +
      (isPartial ? ' [PARTIAL]' : '') +
      ` (${JSON.stringify(productData).length} bytes, ${attrCount} attributes)`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    💥 Failed to process ${slug}: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Головна функція
// ─────────────────────────────────────────────────────────────────────────────
async function run(): Promise<void> {
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

  // ── Перевірка доступності llama.cpp ──────────────────────────────────────
  console.log('🔍 Перевірка з\'єднання з llama.cpp (http://127.0.0.1:8080)...');
  try {
    const health = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(5000) });
    if (health.ok) {
      console.log('✅ llama.cpp доступний.\n');
    } else {
      console.warn(`⚠️  llama.cpp відповів статусом ${health.status}. Продовжуємо.\n`);
    }
  } catch {
    console.error(
      '❌ llama.cpp недоступний на 127.0.0.1:8080.\n' +
      '   Переконайтесь що сервер запущено командою:\n' +
      '   ./llama-server -m <model.gguf> --port 8080 --host 127.0.0.1\n'
    );
    process.exit(1);
  }

  let totalProcessed = 0;
  let totalSkipped   = 0;
  let totalFailed    = 0;
  let totalPartial   = 0;

  for (const [providerKey] of activeProviders) {
    const providerDir = path.join(STORAGE_DIR, providerKey);

    if (!fs.existsSync(providerDir)) {
      console.warn(
        `⚠️  Папка storage/${providerKey}/ не знайдена. ` +
        `Спочатку запустіть downloader.`
      );
      continue;
    }

    const slugs = fs
      .readdirSync(providerDir)
      .filter(name => fs.statSync(path.join(providerDir, name)).isDirectory());

    console.log(`\n🚀 Провайдер: "${providerKey}" — ${slugs.length} товарів`);

    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      console.log(`\n[${i + 1}/${slugs.length}] ${slug}`);

      const dataJsonPath = path.join(STORAGE_DIR, providerKey, slug, 'data.json');

      // Перевіряємо до виклику — щоб правильно рахувати статистику
      const existedBefore = fs.existsSync(dataJsonPath);

      try {
        await processProduct(providerKey, slug);

        if (fs.existsSync(dataJsonPath)) {
          if (existedBefore) {
            // Може бути повторна обробка partial
            const saved = JSON.parse(fs.readFileSync(dataJsonPath, 'utf-8')) as { _partial?: boolean };
            if (saved._partial) {
              totalPartial++;
            } else {
              totalSkipped++;
            }
          } else {
            const saved = JSON.parse(fs.readFileSync(dataJsonPath, 'utf-8')) as { _partial?: boolean };
            if (saved._partial) {
              totalPartial++;
            } else {
              totalProcessed++;
            }
          }
        } else {
          // Був skip (раніше оброблений без _partial)
          totalSkipped++;
        }
      } catch {
        totalFailed++;
      }
    }
  }

  console.log(`
🏁 LLM Processing завершено.
   Оброблено повністю : ${totalProcessed}
   Пропущено (є data.json) : ${totalSkipped}
   Частково (мало даних)   : ${totalPartial}
   Помилка                 : ${totalFailed}
`);
}

run().catch(err => {
  console.error('💥 Критична помилка:', err);
  process.exit(1);
});
