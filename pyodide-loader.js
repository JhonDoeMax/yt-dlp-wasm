class PyodideManager {
    constructor() {
        this.pyodide = null;
        this.ytdlp = null;
        this.isReady = false;
        this.cacheDB = null;
        this.CACHE_VERSION = 'ytdlp-v1';
    }

    async initialize() {
        try {
            // Инициализация IndexedDB для кэша
            await this.initCache();
            
            // Загрузка Pyodide с CDN
            updateStatus('Loading Pyodide runtime...');
            this.pyodide = await loadPyodide({
                indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.1/full/",
                stdout: this.handleStdout.bind(this),
                stderr: this.handleStderr.bind(this)
            });
           
            // +++ ДОБАВЬТЕ ЭТИ ДВЕ СТРОКИ +++
            updateStatus('Loading SSL module...');
            await this.pyodide.loadPackage("ssl");
            // +++++++++++++++++++++++++++++++++
           
            // Далее продолжайте ваш существующий код установки пакетов
            updateStatus('Installing packages...');
            await this.pyodide.loadPackage(['micropip']);
            const micropip = this.pyodide.pyimport('micropip');
            await micropip.install('yt-dlp');
            
            // Monkey-patch для работы в браузере
            await this.patchYtdlp();
            
            // Импорт yt-dlp
            this.ytdlp = this.pyodide.pyimport('yt_dlp');
            
            this.isReady = true;
            updateStatus('Ready to download');
            return true;
        } catch (error) {
            console.error('Pyodide initialization failed:', error);
            updateStatus(`Error: ${error.message}`, 'error');
            return false;
        }
    }

    async initCache() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('ytdlp-cache', 1);
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('extractors')) {
                    db.createObjectStore('extractors', { keyPath: 'url' });
                }
                if (!db.objectStoreNames.contains('formats')) {
                    db.createObjectStore('formats', { keyPath: 'id' });
                }
            };
            
            request.onsuccess = (event) => {
                this.cacheDB = event.target.result;
                resolve();
            };
            
            request.onerror = reject;
        });
    }

    
    async patchYtdlp() {
        const patchCode = `
    import pyodide
    import io
    import json
    import yt_dlp
    import urllib.parse
    import sys

    # Создаем кэш для запросов
    _request_cache = {}

    # Используем CORS прокси для YouTube
    def get_proxy_url(url):
        import urllib.parse
        # Используем публичный CORS прокси
        parsed = urllib.parse.urlparse(url)
        if 'youtube.com' in parsed.netloc or 'youtu.be' in parsed.netloc:
            # Используем CORS прокси сервер
            return f"https://proxy.corsfix.com/?{urllib.parse.quote(url)}"
        return url

class BrowserResponse:
    def __init__(self, content, status_code=200):
        self.content = content
        self.status_code = status_code
        self.headers = {}

    def read(self):
        return self.content

    def close(self):
        pass

    def browser_urlopen(self, request):
        global _request_cache

        # Получаем URL из объекта Request или строки
        if hasattr(request, 'url'):
            url = request.url
        else:
            url = str(request)

        cache_key = url
        if cache_key in _request_cache:
        return BrowserResponse(_request_cache[cache_key])

        try:
            # Используем проксированный URL для YouTube
            proxy_url = get_proxy_url(url)

            # Для YouTube используем специальный подход
            if 'youtube.com' in url or 'youtu.be' in url:
                import js
                import asyncio

                async def fetch_async():
                    try:
                        # Используем прокси
                        response = await js.fetch(proxy_url, {
                            "mode": "cors",
                             "credentials": "omit"
                        })
                        if response.status == 200:
                        # Получаем байты
                        array_buffer = await response.arrayBuffer()
                        # Конвертируем в Python bytes
                        uint8_array = js.Uint8Array.new(array_buffer)
                        py_bytes = pyodide.ffi.toPy(uint8_array)
                        _request_cache[cache_key] = py_bytes
                        return py_bytes
                        else:
                            raise Exception(f"HTTP {response.status}")
                    except Exception as e2:
                    print(f"JS fetch failed: {e2}", file=sys.stderr)
                        # Пробуем альтернативный прокси
                        alt_proxy = f"https://api.allorigins.win/raw?url={urllib.parse.quote(url)}"
                        response2 = await js.fetch(alt_proxy, {"mode": "cors"})
                        if response2.status == 200:
                        array_buffer = await response2.arrayBuffer()
                        uint8_array = js.Uint8Array.new(array_buffer)
                        py_bytes = pyodide.ffi.toPy(uint8_array)
                        _request_cache[cache_key] = py_bytes
                        return py_bytes
                        raise

            # Запускаем асинхронный fetch
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Если цикл уже запущен, используем task
                import asyncio
                task = asyncio.ensure_future(fetch_async())
                result = loop.run_until_complete(task)
            else:
                result = asyncio.run(fetch_async())

                if result:
                return BrowserResponse(result)
                raise Exception("All fetch attempts failed")
            else:
                # Для других сайтов используем стандартный метод
                response = pyodide.http.open_url(proxy_url)
                content = response.read()
                response.close()

                if isinstance(content, bytes):
                _request_cache[cache_key] = content
                return BrowserResponse(content)
            else:
                encoded = content.encode('utf-8', 'ignore')
                _request_cache[cache_key] = encoded
                return BrowserResponse(encoded)

        except Exception as e:
            import sys
            print(f"URL fetch error for {url}: {e}", file=sys.stderr)
            raise

    # Создаем кастомный класс для браузера
    class BrowserYoutubeDL(yt_dlp.YoutubeDL):
        def urlopen(self, request):
            return browser_urlopen(self, request)

    print("✅ yt-dlp patched for browser environment with CORS proxy")
    `;

        try {
            await this.pyodide.runPythonAsync(patchCode);
            console.log("yt-dlp patched successfully");
        } catch (error) {
            console.error("Failed to patch yt-dlp:", error);
            throw error;
        }
    }
    
    async extractInfo(url) {
        if (!this.isReady) throw new Error('Pyodide not ready');
        
        // Проверяем кэш
        const cached = await this.getCachedInfo(url);
        if (cached) return cached;
        
        const code = `
    import json
    
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': False,
        'force_generic_extractor': False,
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-us,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Referer': 'https://www.google.com'
        }
    }
    
    with BrowserYoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info('${url.replace(/'/g, "\\'")}', download=False)
        # Конвертируем в JSON-сериализуемый формат
        info_json = json.dumps(info, default=str)
        info_json
    `;
        
        const result = await this.pyodide.runPythonAsync(code);
        const info = JSON.parse(result);
        
        // Кэшируем результат
        await this.cacheInfo(url, info);
        
        return info;
    }
    
    async getCachedInfo(url) {
        return new Promise((resolve) => {
            const transaction = this.cacheDB.transaction(['extractors'], 'readonly');
            const store = transaction.objectStore('extractors');
            const request = store.get(url);
            
            request.onsuccess = () => {
                if (request.result) {
                    const cached = request.result;
                    // Проверяем срок годности (1 час)
                    if (Date.now() - cached.timestamp < 3600000) {
                        resolve(cached.data);
                    } else {
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            };
            
            request.onerror = () => resolve(null);
        });
    }

    async cacheInfo(url, data) {
        return new Promise((resolve, reject) => {
            const transaction = this.cacheDB.transaction(['extractors'], 'readwrite');
            const store = transaction.objectStore('extractors');
            const item = {
                url: url,
                data: data,
                timestamp: Date.now()
            };
            
            const request = store.put(item);
            request.onsuccess = () => resolve();
            request.onerror = reject;
        });
    }

    handleStdout(text) {
        console.log('[Pyodide]', text);
    }

    handleStderr(text) {
        console.warn('[Pyodide]', text);
    }
}

// Глобальный экземпляр
window.pyodideManager = new PyodideManager();