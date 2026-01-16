import { patchYtdlp } from './ytdlp-patch.js';

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
        await patchYtdlp(this.pyodide);
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