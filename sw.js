const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400'
};

const CORS_URLS = [
    'youtube.com', 'youtu.be', 'vimeo.com', 
    'tiktok.com', 'instagram.com', 'twitter.com'
];

/ Используем более надежный CORS прокси
const CORS_PROXY = 'https://corsproxy.io/?';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
    const url = event.request.url;
    
    // Проксируем только запросы к YouTube
    if ((url.includes('youtube.com') || url.includes('youtu.be')) && 
        event.request.method === 'GET' &&
        !url.includes('corsproxy.io') &&
        !url.includes('api.allorigins.win')) {
        
        event.respondWith(handleYouTubeRequest(event.request));
    }
});

async function handleYouTubeRequest(request) {
    try {
        const proxyUrl = CORS_PROXY + encodeURIComponent(request.url);
        
        const headers = new Headers();
        headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        headers.set('Referer', 'https://www.youtube.com');
        headers.set('Origin', 'https://www.youtube.com');
        headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
        
        const proxyRequest = new Request(proxyUrl, {
            headers: headers,
            mode: 'cors'
        });
        
        return await fetch(proxyRequest);
        
    } catch (error) {
        // Fallback к альтернативному прокси
        try {
            const altProxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(request.url)}`;
            return await fetch(altProxy);
        } catch (fallbackError) {
            return new Response(JSON.stringify({ 
                error: 'Failed to proxy request',
                details: error.message 
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
}
async function proxyRequest(request) {
    try {
        // Добавляем необходимые заголовки
        const proxyHeaders = new Headers(request.headers);
        proxyHeaders.set('Referer', 'https://www.google.com');
        proxyHeaders.set('User-Agent', 
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        
        const proxyRequest = new Request(request.url, {
            headers: proxyHeaders,
            mode: 'no-cors',
            referrerPolicy: 'no-referrer'
        });
        
        const response = await fetch(proxyRequest);
        const modifiedHeaders = new Headers(response.headers);
        
        // Добавляем CORS заголовки к ответу
        Object.entries(CORS_HEADERS).forEach(([key, value]) => {
            modifiedHeaders.set(key, value);
        });
        
        return new Response(response.body, {
            status: response.status,
            headers: modifiedHeaders
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
    }
}