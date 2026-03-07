import { prewarmDevice } from './scraper.js';

const POPULAR = [
    { url: 'https://nanoreview.net/en/phone/apple-iphone-16', label: 'iphone 16' },
    { url: 'https://nanoreview.net/en/phone/apple-iphone-16-pro', label: 'iphone 16 pro' },
    { url: 'https://nanoreview.net/en/phone/samsung-galaxy-s25', label: 'samsung galaxy s25' },
    { url: 'https://nanoreview.net/en/phone/samsung-galaxy-s25-ultra', label: 'samsung galaxy s25 ultra' },
    { url: 'https://nanoreview.net/en/phone/google-pixel-9-pro', label: 'google pixel 9 pro' },
    { url: 'https://nanoreview.net/en/phone/oneplus-13', label: 'oneplus 13' },
    { url: 'https://nanoreview.net/en/soc/qualcomm-snapdragon-8-elite', label: 'snapdragon 8 elite' },
    { url: 'https://nanoreview.net/en/soc/apple-a18-pro', label: 'apple a18 pro' },
    { url: 'https://nanoreview.net/en/gpu/nvidia-geforce-rtx-4090', label: 'rtx 4090' },
    { url: 'https://nanoreview.net/en/gpu/nvidia-geforce-rtx-5090', label: 'rtx 5090' },
    { url: 'https://nanoreview.net/en/cpu/amd-ryzen-9-9950x', label: 'ryzen 9 9950x' },
    { url: 'https://nanoreview.net/en/cpu/intel-core-ultra-9-285k', label: 'intel core ultra 9 285k' },
];

export const prewarmPopular = async () => {
    console.log(`[prewarm] warming ${POPULAR.length} devices...`);
    for (const d of POPULAR) {
        await prewarmDevice(d.url, d.label);
        await new Promise(r => setTimeout(r, 1500)); // stagger
    }
    console.log('[prewarm] all done');
};
