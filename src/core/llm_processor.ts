import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const STORAGE_DIR = path.join(PROJECT_ROOT, 'storage');
const PROVIDERS_CONFIG_PATH = path.join(PROJECT_ROOT, 'providers.json');

// ─── API CONFIGURATION ────────────────────────────────────────────────────────
// Выбор провайдера: 'local' (llama.cpp) или 'gemini' (Google Gemini API через официальный SDK)
let API_PROVIDER: 'local' | 'gemini' = 'gemini';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const LLAMA_URL = 'http://127.0.0.1:8080/v1/chat/completions';
const LLAMA_MODEL = 'local-model';
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

const API_URL = LLAMA_URL;
const API_MODEL = (API_PROVIDER as string) === 'gemini' ? GEMINI_MODEL : LLAMA_MODEL;

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY || 'dummy_key' });

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
  // === Охоронні системи та Сигналізації ===
  'Охоронні системи > Стартові комплекти',
  'Охоронні системи > Хаби',
  'Охоронні системи > Датчики руху',
  'Охоронні системи > Датчики відчинення',
  'Охоронні системи > Датчики скла',
  'Охоронні системи > Датчики вібрації',
  'Охоронні системи > Сирени',
  'Охоронні системи > Брелоки і клавіатури',
  'Охоронні системи > Модулі і розширювачі',
  'Сигналізації',

  // === Відеоспостереження ===
  'Відеоспостереження > Камери',
  'Відеоспостереження > Реєстратори',
  'Відеореєстратори',
  'Відеореєстратори > IP Відеореєстратори',
  'Відеореєстратори > XVR Відеореєстратори',
  'Камери відеоспостереження',
  'Камери відеоспостереження > 4G Відеокамери',
  'Камери відеоспостереження > AHD Відеокамери',
  'Камери відеоспостереження > IP Відеокамери',
  'Камери відеоспостереження > PTZ Відеокамери',
  'Камери відеоспостереження > WiFi Відеокамери',
  'Комплекти відеоспостереження',
  'Комплекти відеоспостереження > IP Комплекти',

  // === Мережеве обладнання ===
  '4G WiFi Роутери',
  'Коммутатори POE', // Залишено подвійне 'м', як у тексті донора

  // === Домофонія ===
  'Домофони > IP Викличні панелі',
  'Домофони > IP Монітори',
  'Домофони > Монітори',
  'Домофони > Викличні панелі',

  // === Системи контролю доступу ===
  'Системи контролю доступу > Контролери',
  'Системи контролю доступу > Зчитувачі',
  'Системи контролю доступу > Замки',
  'Системи контролю доступу > Кнопки виходу',
  'Системи контролю доступу > Ключі доступу (RFID картки та брелки)',

  // === Джерела живлення ===
  'Джерела живлення',
  'Джерела живлення > Блоки живлення',
  'Джерела живлення > Джерела безперебійного живлення 12-24В',

  // === Пожежна безпека та Захист від затоплення ===
  'Пожежна безпека > Датчики диму',
  'Пожежна безпека > Датчики вогню',
  'Пожежна безпека > Датчики газу',
  'Захист від затоплення > Датчики протікання',

  // === Автоматизація ===
  'Автоматизація > Розумний дім',

  // === Додаткове обладнання та Аксесуари ===
  'Додаткове обладнання',
  'Додаткове обладнання > Жорсткі диски',
  'Додаткове обладнання > Кабель',
  'Додаткове обладнання > Карти пам\'яті', // Одинарні лапки екрановані
  'Аксесуари > Кріплення і монтаж',
  'Аксесуари > Блоки живлення',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Системний промпт
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(): string {
  return `Ти — досвідчений контент-менеджер інтернет-магазину систем безпеки та відеоспостереження.
Твоя задача — проаналізувати очищений текст сторінки і повернути JSON-об'єкт ТІЛЬКИ для головного товару цієї сторінки.

КРИТИЧНО ВАЖЛИВІ ПРАВИЛА КОНТЕКСТУ:
1. ІГНОРУЙ будь-який текст, що не стосується головного товару: навігаційне меню, посилання в футері, інформацію про доставку та оплату, відгуки покупців, статті блогу, блоки "Схожі товари", "З цим товаром також купують", списки брендів та інформацію про кукі-файли чи налаштування згоди.
2. Всі поля JSON (name, description, attributes, price тощо) повинні містити інформацію СТРОГО про ОДИН головний товар, сторінці якого присвячений цей текст.
3. НЕ використовуй характеристики інших товарів (наприклад, супутніх чи аксесуарів), що згадуються далі по тексту сторінки.

ОБОВ'ЯЗКОВІ ПРАВИЛА ФОРМАТУВАННЯ:
1. Повертай ТІЛЬКИ валідний JSON. Без markdown-обгортки (\`\`\`json ... \`\`\`), без коментарів, без пояснень.
2. Використовуй мову оригінального сайту (якщо сайт українською — пиши українською).
3. Якщо якоїсь інформації немає на сторінці — залишай поле порожнім рядком "", числове поле — 0, масив — [].
4. НЕ вигадуй дані яких немає на сторінці.
5. description — HTML з тегами <p>, <ul>, <li>, <strong>. Інформативний, на основі реального опису головного товару.
6. meta_title — до 160 символів, включає назву і ключове слово.
7. meta_description — 150–300 символів, заклики + переваги.
8. meta_keyword — 5–10 ключових слів через кому.
9. tags — 3–8 тегів через кому.
10. category — ОБОВ'ЯЗКОВО вибери ОДНУ категорію з наступного списку (точний текст):
${ALLOWED_CATEGORIES.map(c => `   - "${c}"`).join('\n')}
11. model і sku — артикул та модель саме этого товару. Якщо не знайшов — "".
12. price — числова ціна товару в гривнях (тільки число, без валюти). Якщо ціни немає — 0.
13. weight — рядок з одиницями ("0.32 кг"). Якщо не знайшов — "".
14. dimensions — рядок LxWxH з одиницями ("163 x 163 x 36 мм"). Якщо не знайшов — "".
15. attributes — витягни технічні характеристики тільки для головного товару (наприклад: group - "Технічні характеристики", name - "Дальність передачі", value - "до 2000 м"). Якщо їх немає — [].
16. in_stock — логічне значення (true/false) наявності головного товару.

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
// Rate Limiter для Gemini (максимум 12 запитів на хвилину)
// ─────────────────────────────────────────────────────────────────────────────
let lastRequestTime = 0;

async function throttleRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  const minInterval = 5000; // 5 секунд = максимум 12 запитів на хвилину

  if (timeSinceLast < minInterval) {
    const delay = minInterval - timeSinceLast;
    console.log(`    ⏳ Очікування ліміту квот (пауза ${delay} мс)...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  lastRequestTime = Date.now();
}

// ─────────────────────────────────────────────────────────────────────────────
// llama.cpp / Gemini API
// ─────────────────────────────────────────────────────────────────────────────
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function callLlama(messages: ChatMessage[]): Promise<string> {
  if (API_PROVIDER === 'gemini') {
    if (!GEMINI_API_KEY) {
      throw new Error('Змінна оточення GEMINI_API_KEY не задана!');
    }

    await throttleRateLimit();

    const systemMessage = messages.find(m => m.role === 'system');
    const system_instruction = systemMessage ? systemMessage.content : undefined;

    const steps = messages
      .filter(m => m.role !== 'system')
      .map(msg => {
        if (msg.role === 'assistant') {
          return {
            type: 'model_output' as const,
            content: [{ type: 'text' as const, text: msg.content }],
          };
        } else {
          return {
            type: 'user_input' as const,
            content: [{ type: 'text' as const, text: msg.content }],
          };
        }
      });

    const interaction = await ai.interactions.create({
      model: GEMINI_MODEL,
      system_instruction,
      input: steps,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
      },
      generation_config: {
        temperature: 0.1,
        max_output_tokens: 8192,
      },
    });

    const content = interaction.output_text;
    if (!content) {
      throw new Error('Gemini Interactions API returned empty response content');
    }
    return content;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: API_MODEL,
      messages,
      response_format: { type: 'json_object' }, // гарантує JSON-відповідь
      stream: false,
      temperature: 0.1,   // мінімум галюцинацій
      max_tokens: 8192,   // достатньо для великих товарів
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
// Очищення тексту сторінки від зайвих HTML тегів та форматування
// ─────────────────────────────────────────────────────────────────────────────
function cleanRawText(rawHtml: string): string {
  let text = rawHtml;

  // 1. Видаляємо коментарі
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Видаляємо скрипти, стилі, noscript, iframe, форми разом з контентом
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
  text = text.replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '');

  // 3. Замінюємо блочні теги та перенесення рядків на символи нового рядка для читабельності структури
  text = text.replace(/<\/(p|div|tr|li|h1|h2|h3|h4|h5|h6|table|header|footer|nav|aside)>\s*/gi, '\n');
  text = text.replace(/<(br|hr)\b[^>]*\/?>\s*/gi, '\n');

  // 4. Видаляємо всі інші HTML-теги
  text = text.replace(/<[^>]+>/g, ' ');

  // 5. Декодуємо загальні HTML-сутності
  const htmlEntities: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&quot;': '"',
    '&lt;': '<',
    '&gt;': '>',
    '&apos;': "'",
    '&#39;': "'",
    '&#039;': "'",
    '&ndash;': '–',
    '&mdash;': '—',
  };
  text = text.replace(/&[a-zA-Z0-9#]+;/g, (match) => htmlEntities[match] || match);

  // 6. Форматуємо пробіли та пусті рядки, фільтруємо сміттєві рядки (кукі, згоди, тощо)
  const noisePatterns = [
    /cookie/i,
    /конфиденциальность/i,
    /конфіденційність/i,
    /принять все/i,
    /прийняти всі/i,
    /отклонить/i,
    /відхилити/i,
    /настроить/i,
    /налаштувати/i,
    /политика использования/i,
    /політика використання/i,
    /согласие/i,
    /згода/i,
    /продолжительность/i,
    /тривалість/i,
    /описание/i,
    /опис/i,
    /срок действия/i,
    /термін дії/i,
    /сеанс/i,
    /always active/i,
    /всегда активные/i,
    /завжди активні/i,
    /no description/i,
    /description is currently not available/i,
    /^\d+\s+(year|month|day|hour|minute|second|week|год|лет|месяц|день|час|минут|секунд|недел|тиж|міс|рік|рок|годин|хвил|дней|часов|минуты|секунды|недели|месяца|дня|день|минута|секунда|сеанс)/i,
    /^(necessar|functional|analytics|advertis|необходим|функциональ|аналитик|реклам)/i,
  ];

  text = text.split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim()) // об'єднуємо пробіли в рядку
    .filter(line => {
      if (line.length === 0) return false;
      if (noisePatterns.some(pattern => pattern.test(line))) return false;
      return true;
    })
    .join('\n');                                      // об'єднуємо через один символ нового рядка

  return text.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Цикл валідації з повторними запитами
// Якщо після MAX_RETRIES повна схема не проходить — зберігаємо частковий запис
// ─────────────────────────────────────────────────────────────────────────────
async function processWithRetry(
  text: string,
  slug: string
): Promise<ProductData | PartialProductData> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: `Проаналізуй цей текст сторінки товару і поверни JSON:\n\n${text}`,
    },
  ];

  let lastParsed: unknown = null;
  let lastRaw    = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const providerName = API_PROVIDER === 'gemini' ? 'Gemini' : 'llama.cpp';
    console.log(`    🤖 ${providerName} запит ${attempt}/${MAX_RETRIES}...`);

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

  const providerName = API_PROVIDER === 'gemini' ? 'Gemini' : 'llama.cpp';
  throw new Error(
    `Не вдалося отримати валідний JSON від ${providerName} для "${slug}" після ${MAX_RETRIES} спроб. ` +
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
  const cleanedText = cleanRawText(html);

  // Тримаємо очищений текст в межах контексту моделі (~16k символів)
  const MAX_TEXT_CHARS = 16_000;
  const truncatedText = cleanedText.length > MAX_TEXT_CHARS
    ? cleanedText.slice(0, MAX_TEXT_CHARS) + '\n[Text truncated...]'
    : cleanedText;

  try {
    const productData = await processWithRetry(truncatedText, slug);
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

  // ── Перевірка доступності API ─────────────────────────────────────────────
  if (API_PROVIDER === 'gemini') {
    console.log('🔍 Використовуємо Google Gemini API...');
    if (!GEMINI_API_KEY) {
      console.error(
        '❌ Змінна оточення GEMINI_API_KEY не задана!\n' +
        '   Задайте її перед запуском:\n' +
        '   export GEMINI_API_KEY="ваш_ключ_api"\n'
      );
      process.exit(1);
    }
    console.log('✅ Ключ GEMINI_API_KEY задано. Продовжуємо.\n');
  } else {
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
