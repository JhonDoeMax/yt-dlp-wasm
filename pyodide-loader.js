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
    import pyodide.http
    import json
    
    # Создаем кэш для запросов
    _request_cache = {}
    
    def browser_urlopen(self, url):
        global _request_cache
        
        cache_key = str(url)
        if cache_key in _request_cache:
            return _request_cache[cache_key]
        
        try:
            # Синхронный запрос через pyodide.http.open_url
            response = pyodide.http.open_url(str(url))
            content = response.read()
            response.close()
            
            # Конвертируем bytes в строку если нужно
            if isinstance(content, bytes):
                content = content.decode('utf-8', 'ignore')
            
            _request_cache[cache_key] = content
            return content
        except Exception as e:
            import sys
            print(f"URL fetch error for {url}: {e}", file=sys.stderr)
            
            # Fallback: пробуем через js.fetch асинхронно
            import js
            import asyncio
            
            # Создаем Future для асинхронного ожидания
            async def fetch_async():
                try:
                    response = await js.fetch(str(url), {
                        "mode": "cors",
                        "credentials": "omit",
                        "headers": {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            "Referer": "https://www.google.com"
                        }
                    })
                    text = await response.text()
                    _request_cache[cache_key] = text
                    return text
                except Exception as e2:
                    print(f"JS fetch also failed: {e2}", file=sys.stderr)
                    return ""
            
            # Запускаем синхронно (блокируем до получения результата)
            from asyncio import run
            result = run(fetch_async())
            if result:
                _request_cache[cache_key] = result
                return result
            raise
    
    # Монки-патчим метод urlopen в YoutubeDL
    from yt_dlp import YoutubeDL
    original_urlopen = YoutubeDL.urlopen
    
    def patched_urlopen(self, url):
        return browser_urlopen(self, url)
    
    YoutubeDL.urlopen = patched_urlopen
    
    print("✅ yt-dlp patched for browser environment")
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
from yt_dlp import YoutubeDL
import json

ydl_opts = {
    'quiet': True,
    'no_warnings': True,
    'extract_flat': False,
    'force_generic_extractor': False,
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