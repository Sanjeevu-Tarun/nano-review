// Pre-warm the most commonly searched devices
// These run in the background after CF warmup, staggered to avoid hammering the server

import { scrapeUrl } from './scraper.js';

// Add/remove devices based on what your users actually search for
const POPULAR_DEVICES = [
    { url: 'https://nanoreview.net/en/phone/apple-iphone-16', label: 'iphone 16' },
    { url: 'https://nanoreview.net/en/phone/apple-iphone-16-pro', label: 'iphone 16 pro' },
    { url: 'https://nanoreview.net/en/phone/apple-iphone-15', label: 'iphone 15' },
    { url: 'https://nanoreview.net/en/phone/samsung-galaxy-s25', label: 'samsung galaxy s25' },
    { url: 'https://nanoreview.net/en/phone/samsung-galaxy-s25-ultra', label: 'samsung galaxy s25 ultra' },
    { url: 'https://nanoreview.net/en/phone/google-pixel-9', label: 'pixel 9' },
    { url: 'https://nanoreview.net/en/phone/google-pixel-9-pro', label: 'pixel 9 pro' },
    { url: 'https://nanoreview.net/en/phone/oneplus-13', label: 'oneplus 13' },
    { url: 'https://nanoreview.net/en/soc/apple-a18', label: 'apple a18' },
    { url: 'https://nanoreview.net/en/soc/qualcomm-snapdragon-8-elite', label: 'snapdragon 8 elite' },
    { url: 'https://nanoreview.net/en/soc/mediatek-dimensity-9400', label: 'dimensity 9400' },
    { url: 'https://nanoreview.net/en/cpu/amd-ryzen-9-9950x', label: 'ryzen 9 9950x' },
    { url: 'https://nanoreview.net/en/cpu/intel-core-ultra-9-285k', label: 'intel core ultra 9 285k' },
    { url: 'https://nanoreview.net/en/gpu/nvidia-geforce-rtx-5090', label: 'rtx 5090' },
    { url: 'https://nanoreview.net/en/gpu/nvidia-geforce-rtx-4090', label: 'rtx 4090' },
];

export const prewarmPopular = async (context) => {
    console.log(`[prewarm] starting ${POPULAR_DEVICES.length} devices...`);
    // Stagger requests — 1 every 2 seconds to avoid rate limiting
    for (const device of POPULAR_DEVICES) {
        await scrapeUrl(context, device.url, device.label);
        await new Promise(r => setTimeout(r, 2000));
    }
    console.log('[prewarm] complete');
};
