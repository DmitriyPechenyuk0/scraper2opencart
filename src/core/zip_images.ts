import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const STORAGE_DIR = path.join(PROJECT_ROOT, 'storage');
const PROVIDERS_CONFIG_PATH = path.join(PROJECT_ROOT, 'providers.json');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'export');
const TEMP_DIR = path.join(OUTPUT_DIR, 'temp');

async function run() {
    console.log('📦 Starting image zipping process...');

    if (!fs.existsSync(PROVIDERS_CONFIG_PATH)) {
        console.error(`❌ providers.json not found at ${PROVIDERS_CONFIG_PATH}`);
        process.exit(1);
    }

    const providers = JSON.parse(fs.readFileSync(PROVIDERS_CONFIG_PATH, 'utf-8'));
    const activeProviders = Object.entries(providers).filter(([, cfg]: any) => cfg.involved);

    if (activeProviders.length === 0) {
        console.log('No active providers configured in providers.json. Exiting.');
        return;
    }

    const targetBaseDir = path.join(TEMP_DIR, 'catalog/products');
    if (fs.existsSync(TEMP_DIR)) {
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(targetBaseDir, { recursive: true });

    let imageCount = 0;

    for (const [providerKey] of activeProviders) {
        const providerDir = path.join(STORAGE_DIR, providerKey);
        if (!fs.existsSync(providerDir)) {
            console.warn(`⚠️  Provider folder storage/${providerKey} not found. Skipping.`);
            continue;
        }

        const slugs = fs.readdirSync(providerDir).filter(name => 
            fs.statSync(path.join(providerDir, name)).isDirectory()
        );

        for (const slug of slugs) {
            const srcImagesDir = path.join(providerDir, slug, 'images');
            if (!fs.existsSync(srcImagesDir)) continue;

            const files = fs.readdirSync(srcImagesDir).filter(f => 
                /\.(webp|avif|jpg|jpeg|png)$/i.test(f)
            );

            if (files.length === 0) continue;

            const destProductDir = path.join(targetBaseDir, slug);
            fs.mkdirSync(destProductDir, { recursive: true });

            for (const file of files) {
                fs.copyFileSync(
                    path.join(srcImagesDir, file),
                    path.join(destProductDir, file)
                );
                imageCount++;
            }
        }
    }

    if (imageCount === 0) {
        console.log('No images found in storage to zip. Exiting.');
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        return;
    }

    console.log(`Copied ${imageCount} images to temporary catalog folder structure.`);

    const zipFilePath = path.join(OUTPUT_DIR, 'opencart_images.zip');
    if (fs.existsSync(zipFilePath)) {
        fs.rmSync(zipFilePath, { force: true });
    }

    try {
        console.log('Creating ZIP archive...');
        // Run native zip command relative to the temp folder
        execSync(`zip -r "${zipFilePath}" catalog`, { cwd: TEMP_DIR, stdio: 'inherit' });
        console.log(`\n✅ Successfully created ZIP archive: ${zipFilePath}`);
    } catch (error: any) {
        console.error('💥 Error running zip command:', error.message);
        console.log('Please ensure the "zip" utility is installed on your Linux system (e.g. sudo apt install zip).');
    } finally {
        console.log('Cleaning up temporary files...');
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        console.log('Done!');
    }
}

run().catch(console.error);
