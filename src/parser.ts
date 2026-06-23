import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const catalogUrl = 'https://ajax.systems/ru-ua/catalogue/baseline-intrusion-protection/';
const outputJsonPath = './product_urls.json';

async function parseCatalog(): Promise<void> {
    console.log(`🔎 Запуск тотального парсера каталога: ${catalogUrl}`);

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'uk-UA',
        timezoneId: 'Europe/Kyiv'
    });

    const page = await context.newPage();

    try {
        await page.goto(catalogUrl, { waitUntil: 'networkidle' });
        
        console.log('📜 Загружаем все страницы каталога с помощью кнопки "Показати більше"...');

        let clickCount = 0;
        while (true) {
            // Скроллим вниз, чтобы кнопка гарантированно была видна и доступна для клика
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(1000);

            // Удаляем cookie consent banner и overlay, если они мешают клику
            await page.evaluate(() => {
                document.querySelectorAll('.cky-consent-container, .cky-overlay').forEach(el => el.remove());
            });

            const moreButton = page.locator('button[data-testid="pagination-more-button"]');
            if (await moreButton.isVisible()) {
                if (await moreButton.isDisabled()) {
                    console.log('Кнопка "Показати більше" отключена (disabled). Все страницы загружены!');
                    break;
                }

                const currentPage = await moreButton.getAttribute('data-page');
                console.log(`Найдена кнопка "Показати більше" (текущая страница: ${currentPage}). Кликаем...`);
                
                await moreButton.click();
                clickCount++;

                // Ждем, пока кнопка либо исчезнет, либо станет disabled, либо её data-page обновится
                try {
                    await page.waitForFunction(
                        ({ oldPage }) => {
                            const btn = document.querySelector('button[data-testid="pagination-more-button"]');
                            if (!btn) return true;
                            if (btn.hasAttribute('disabled')) return true;
                            const newPage = btn.getAttribute('data-page');
                            return newPage !== oldPage;
                        },
                        { oldPage: currentPage },
                        { timeout: 8000 }
                    );
                } catch (e) {
                    console.log('Таймаут ожидания обновления кнопки. Возможно, это последняя страница.');
                }
                
                await page.waitForTimeout(1000);
            } else {
                console.log('Кнопка "Показати більше" не найдена или больше не видна. Все страницы загружены!');
                break;
            }
        }

        console.log('⚡ Извлекаем ссылки на товары из прогруженного DOM...');

        const urls: string[] = await page.evaluate(() => {
            const links: string[] = [];
            
            document.querySelectorAll('a').forEach(a => {
                const href = a.getAttribute('href');
                if (href) {
                    try {
                        const urlObj = new URL(href, window.location.origin);
                        const parts = urlObj.pathname.split('/').filter(Boolean);
                        
                        // Проверяем, что это ссылка на конкретный товар (например, /ua/products/starterkit/)
                        // а не на сам каталог (/ua/products/) или подраздел
                        const isProduct = parts.length >= 2 && parts[parts.length - 2] === 'products';
                        
                        if (isProduct) {
                            links.push(urlObj.pathname);
                        }
                    } catch (e) {
                        // Игнорируем некорректные ссылки
                    }
                }
            });

            return Array.from(new Set(links)).map(pathname => window.location.origin + pathname);
        });

        // Фильтруем случайный мусор (инструкции, саппорт, блоги)
        const cleanUrls = urls.filter(url => {
            const lower = url.toLowerCase();
            return !lower.includes('/support') && 
                   !lower.includes('/blog') && 
                   !lower.includes('/where-to-buy') && 
                   !lower.includes('/cases');
        });

        console.log(`\n📊 Успешно собрано товаров: ${cleanUrls.length}`);

        // Сохраняем в JSON
        fs.writeFileSync(outputJsonPath, JSON.stringify(cleanUrls, null, 2), 'utf-8');
        console.log(`✅ Список из ${cleanUrls.length} ссылок записан в: ${outputJsonPath}`);

    } catch (error: any) {
        console.error('💥 Ошибка при парсинге:', error.message);
    } finally {
        await page.close();
        await browser.close();
        console.log('\n🚀 Скрипт полностью завершил работу!');
    }
}

parseCatalog();
