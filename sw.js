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

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    
    // Проксируем только запросы к целевым сайтам
    const shouldProxy = CORS_URLS.some(domain => url.href.includes(domain));
    
    if (shouldProxy && event.request.method === 'GET') {
        event.respondWith(proxyRequest(event.request));
    }
});

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