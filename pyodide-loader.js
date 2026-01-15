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
                indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/",
                stdout: this.handleStdout.bind(this),
                stderr: this.handleStderr.bind(this)
            });

            // Установка необходимых пакетов
            updateStatus('Installing packages...');
            await this.pyodide.loadPackage(['micropip']);
            const micropip = this.pyodide.pyimport('micropip');
            
            // Установка yt-dlp и зависимостей
            await micropip.install('yt-dlp');
            await micropip.install('websockets'); // Для некоторых extractors
            
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
import js
import sys
from yt_dlp import YoutubeDL
from yt_dlp.extractor.common import InfoExtractor

class BrowserYoutubeDL(YoutubeDL):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._cache = {}
    
    def urlopen(self, url):
        # Используем fetch из JavaScript для обхода CORS
        import js
        import json
        
        # Проверяем кэш
        cache_key = str(url)
        if cache_key in self._cache:
            return self._cache[cache_key]
        
        # Делаем запрос через fetch
        response = js.fetch(str(url), {
            "mode": "cors",
            "credentials": "omit",
            "headers": {
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://www.google.com"
            }
        })
        
        # Конвертируем ответ в строку
        result = response.text()
        self._cache[cache_key] = result
        return result

# Патчим все extractors
original_extract = InfoExtractor._real_extract
def patched_extract(self, url):
    try:
        return original_extract(self, url)
    except Exception as e:
        # Fallback: пробуем через JavaScript
        import js
        js.console.warn(f"Extractor failed, trying JS fallback: {e}")
        # Здесь можно добавить ytdl-core fallback
        raise

InfoExtractor._real_extract = patched_extract
`;
        await this.pyodide.runPythonAsync(patchCode);
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