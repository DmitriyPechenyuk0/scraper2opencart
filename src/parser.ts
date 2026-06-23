import fs from 'node:fs';
import path from 'node:path';
import { chromium, Response } from 'playwright';

const productUrls: string[] = [
    "https://ajax.systems/ru-ua/products/starterkit-cam-plus/",
    "https://ajax.systems/ru-ua/products/starterkit-cam/",
    "https://ajax.systems/ru-ua/products/starterkit-plus/",
    "https://ajax.systems/ru-ua/products/starterkit-2/",
    "https://ajax.systems/ru-ua/products/starterkit/",
    "https://ajax.systems/ru-ua/products/hub2-plus/",
    "https://ajax.systems/ru-ua/products/hub-2/",
    "https://ajax.systems/ru-ua/products/hub/",
    "https://ajax.systems/ru-ua/products/hub-bp/",
    "https://ajax.systems/ru-ua/products/rex-2/",
    "https://ajax.systems/ru-ua/products/rex/",
    "https://ajax.systems/ru-ua/products/doorprotect/",
    "https://ajax.systems/ru-ua/products/doorprotectplus/",
    "https://ajax.systems/ru-ua/products/glassprotect/",
    "https://ajax.systems/ru-ua/products/motionprotect/",
    "https://ajax.systems/ru-ua/products/motionprotectplus/",
    "https://ajax.systems/ru-ua/products/combiprotect/",
    "https://ajax.systems/ru-ua/products/motioncam/",
    "https://ajax.systems/ru-ua/products/motioncam-phod/",
    "https://ajax.systems/ru-ua/products/motionprotect-curtain/",
    "https://ajax.systems/ru-ua/products/curtain-outdoor-jeweller/",
    "https://ajax.systems/ru-ua/products/curtain-outdoor-mini-jeweller/",
    "https://ajax.systems/ru-ua/products/dualcurtain-outdoor/",
    "https://ajax.systems/ru-ua/products/motionprotect-outdoor/",
    "https://ajax.systems/ru-ua/products/motioncam-outdoor/",
    "https://ajax.systems/ru-ua/products/motioncam-outdoor-phod/",
    "https://ajax.systems/ru-ua/products/motioncam-outdoor-highmount-phod/",
    "https://ajax.systems/ru-ua/products/curtaincam-outdoor-highmount-phod-jeweller/",
    "https://ajax.systems/ru-ua/products/button/",
    "https://ajax.systems/ru-ua/products/doublebutton/",
    "https://ajax.systems/ru-ua/products/ajaxspacecontrol/",
    "https://ajax.systems/ru-ua/products/keypad-touchscreen/",
    "https://ajax.systems/ru-ua/products/keypad-plus/",
    "https://ajax.systems/ru-ua/products/keypad/",
    "https://ajax.systems/ru-ua/products/keypad-outdoor-jeweller/",
    "https://ajax.systems/ru-ua/products/streetsiren-doubledeck/",
    "https://ajax.systems/ru-ua/products/streetsiren/",
    "https://ajax.systems/ru-ua/products/homesiren/",
    "https://ajax.systems/ru-ua/products/speakerphone-jeweller/",
    "https://ajax.systems/ru-ua/products/multitransmitter/",
    "https://ajax.systems/ru-ua/products/transmitter/",
    "https://ajax.systems/ru-ua/products/vhfbridge/",
    "https://ajax.systems/ru-ua/products/wallswitch/",
    "https://ajax.systems/ru-ua/products/relay/",
    "https://ajax.systems/ru-ua/products/6vpsu/",
    "https://ajax.systems/ru-ua/products/12-24vpsu-hub2/",
    "https://ajax.systems/ru-ua/products/12vpsu/",
]

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function parseProducts(): Promise<void> {
    const baseDownloadDir = './downloaded_products';

    const browser = await chromium.launch({ headless: false });
    
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'uk-UA',
        timezoneId: 'Europe/Kyiv',
        extraHTTPHeaders: {
            'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7'
        }
    });

    for (const url of productUrls) {
        const page = await context.newPage();
        
        // Полностью ОТКЛЮЧАЕМ кэш браузера, чтобы он скачивал всё заново по сети
        await page.route('**/*', async (route) => {
            const headers = route.request().headers();
            headers['Pragma'] = 'no-cache';
            headers['Cache-Control'] = 'no-cache';
            await route.continue({ headers });
        });

        const interceptedImages: Map<string, Buffer> = new Map();
        let base64Count = 0;

        // 1. СЕТЕВОЙ ПЕРХВАТЧИК (Ловит всё, включая картинки из CSS, стилей и скриптов)
        page.on('response', async (response: Response) => {
            const reqUrl = response.url();
            const contentType = response.headers()['content-type'] || '';

            // Проверяем тип контента. Если это картинка — забираем. Вообще без фильтрации по размеру или имени.
            if (contentType.toLowerCase().includes('image/') || /\.(jpg|jpeg|png|webp|avif|gif)$/i.test(reqUrl)) {
                try {
                    const buffer = await response.body();
                    if (buffer && buffer.length > 0) {
                        interceptedImages.set(reqUrl, buffer);
                    }
                } catch (e) {
                    // Игнорируем ошибки отмененных сетью стримов
                }
            }
        });

        try {
            console.log(`\n🔎 Загружаем страницу: ${url}`);
            await page.goto(url, { waitUntil: 'networkidle' });
            await delay(2000);

            console.log('📜 Пошел агрессивный скролл до самого низа...');
            await page.evaluate(async () => {
                await new Promise<void>((resolve) => {
                    let totalHeight = 0;
                    const distance = 200; // Маленький шаг, чтобы триггерить абсолютно всё
                    const timer = setInterval(() => {
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;

                        if (totalHeight >= scrollHeight || totalHeight > 15000) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 50);
                });
            });

            console.log('⏳ Ожидаем стабилизации медиа-потоков...');
            await delay(5000);

            const productSlug = url.split('/').filter(Boolean).pop();
            if (!productSlug) continue;

            const productFolder = path.join(baseDownloadDir, productSlug);
            if (!fs.existsSync(productFolder)) {
                fs.mkdirSync(productFolder, { recursive: true });
            }

            // 2. ДОП. ПЕРХВАТ BASE64 (Вытаскиваем картинки, зашитые прямо в DOM код)
            console.log('📦 Ищем встроенные Base64 изображения в DOM...');
            const base64Images: string[] = await page.evaluate(() => {
                const srcList: string[] = [];
                document.querySelectorAll('img, source').forEach(el => {
                    const src = el.getAttribute('src') || el.getAttribute('srcset') || '';
                    if (src.startsWith('data:image/')) {
                        srcList.push(src);
                    }
                });
                return srcList;
            });

            // Конвертируем Base64 в буферы и добавляем в общую кучу
            for (const base64Str of base64Images) {
                try {
                    const matches = base64Str.match(/^data:image\/([A-Za-z\-]+);base64,(.+)$/);
                    if (matches && matches.length === 3) {
                        const buffer = Buffer.from(matches[2], 'base64');
                        interceptedImages.set(`base64_embedded_${base64Count++}`, buffer);
                    }
                } catch (e) {}
            }

            const uniqueImages = Array.from(interceptedImages.entries());
            console.log(`\n📸 Всего найдено и извлечено медиа-файлов: ${uniqueImages.length}`);

            // Сохраняем АБСОЛЮТНО ВСЁ на диск
            for (let index = 0; index < uniqueImages.length; index++) {
                const [imgUrl, buffer] = uniqueImages[index];
                
                const fileIndex = String(index + 1).padStart(3, '0');
                
                // Пытаемся угадать расширение
                let ext = '.png';
                if (imgUrl.toLowerCase().includes('jpeg') || imgUrl.toLowerCase().includes('jpg')) ext = '.jpg';
                if (imgUrl.toLowerCase().includes('webp')) ext = '.webp';
                if (imgUrl.toLowerCase().includes('avif')) ext = '.avif';
                if (imgUrl.toLowerCase().includes('gif')) ext = '.gif';
                if (imgUrl.toLowerCase().includes('svg') || imgUrl.startsWith('data:image/svg')) ext = '.svg';

                const filename = `media_${fileIndex}_${productSlug}${ext}`;
                const targetPath = path.join(productFolder, filename);

                fs.writeFileSync(targetPath, buffer);
            }

            console.log(`\n✅ Готово! В папку [${productSlug}] выкачано абсолютно всё.`);

        } catch (error: any) {
            console.error(`💥 Ошибка:`, error.message);
        } finally {
            await page.close();
        }
    }

    await browser.close();
    console.log('\n🚀 Скрипт работу завершил!');
}

parseProducts();