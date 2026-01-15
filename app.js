class VideoDownloader {
    constructor() {
        this.currentInfo = null;
        this.selectedFormat = null;
        this.downloadController = null;
        this.ffmpeg = null;
        this.isDownloading = false;
        
        this.initUI();
        this.initFFmpeg();
        this.registerServiceWorker();
    }

    initUI() {
        // Элементы UI
        this.elements = {
            urlInput: document.getElementById('urlInput'),
            fetchBtn: document.getElementById('fetchBtn'),
            videoInfo: document.getElementById('videoInfo'),
            formatsSection: document.getElementById('formatsSection'),
            downloadSection: document.getElementById('downloadSection'),
            progressBar: document.getElementById('downloadProgress'),
            progressText: document.getElementById('progressText'),
            speedInfo: document.getElementById('speedInfo'),
            timeInfo: document.getElementById('timeInfo')
        };

        // События
        this.elements.fetchBtn.addEventListener('click', () => this.fetchVideoInfo());
        this.elements.urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.fetchVideoInfo();
        });

        // Фильтры форматов
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.filterFormats(e.target.dataset.filter));
        });
    }

    async initFFmpeg() {
        try {
            this.ffmpeg = FFmpeg.createFFmpeg({
                corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
                log: true
            });
            await this.ffmpeg.load();
        } catch (error) {
            console.warn('FFmpeg failed to load:', error);
        }
    }

    async registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            try {
                await navigator.serviceWorker.register('/sw.js');
                console.log('Service Worker registered');
            } catch (error) {
                console.warn('Service Worker registration failed:', error);
            }
        }
    }

    async fetchVideoInfo() {
        const url = this.elements.urlInput.value.trim();
        if (!url) return;

        this.showLoading(true);
        updateStatus('Extracting video info...');

        try {
            if (!window.pyodideManager.isReady) {
                await window.pyodideManager.initialize();
            }

            const info = await window.pyodideManager.extractInfo(url);
            this.currentInfo = info;
            this.displayVideoInfo(info);
            this.displayFormats(info.formats);
            
            updateStatus('Ready to download');
        } catch (error) {
            updateStatus(`Error: ${error.message}`, 'error');
            console.error('Extraction failed:', error);
            
            // Fallback на ytdl-core для YouTube
            if (url.includes('youtube.com') || url.includes('youtu.be')) {
                await this.fallbackToYtdlCore(url);
            }
        } finally {
            this.showLoading(false);
        }
    }

    displayVideoInfo(info) {
        const { videoInfo } = this.elements;
        
        document.getElementById('videoTitle').textContent = info.title;
        document.getElementById('videoDuration').textContent = 
            `Duration: ${this.formatDuration(info.duration)}`;
        document.getElementById('videoUploader').textContent = 
            `Uploader: ${info.uploader || 'Unknown'}`;
        
        if (info.thumbnail) {
            document.getElementById('videoThumb').src = info.thumbnail;
        }
        
        videoInfo.hidden = false;
    }

    displayFormats(formats) {
        const container = document.getElementById('formatsContainer');
        container.innerHTML = '';
        
        formats.forEach(format => {
            if (!format.url || !format.ext) return;
            
            const formatCard = this.createFormatCard(format);
            container.appendChild(formatCard);
        });
        
        this.elements.formatsSection.hidden = false;
    }

    createFormatCard(format) {
        const card = document.createElement('div');
        card.className = 'format-card';
        card.dataset.formatId = format.format_id;
        card.dataset.type = format.vcodec === 'none' ? 'audio' : 'video';
        
        const resolution = format.resolution || format.width + 'x' + format.height;
        const filesize = format.filesize ? this.formatFileSize(format.filesize) : 'Unknown';
        const note = format.format_note || format.ext.toUpperCase();
        
        card.innerHTML = `
            <div class="format-header">
                <span class="format-note">${note}</span>
                <span class="format-resolution">${resolution}</span>
            </div>
            <div class="format-details">
                <span>${format.ext.toUpperCase()}</span>
                <span>${filesize}</span>
                <span>${format.fps || ''}${format.fps ? 'fps' : ''}</span>
            </div>
            <button class="select-btn">Select</button>
        `;
        
        card.querySelector('.select-btn').addEventListener('click', 
            () => this.selectFormat(format));
        
        return card;
    }

    async selectFormat(format) {
        this.selectedFormat = format;
        this.elements.downloadSection.hidden = false;
        
        // Показываем опции постобработки
        if (format.vcodec === 'none') {
            document.getElementById('postProcessing').hidden = false;
            document.getElementById('convertToMp3').checked = true;
        }
        
        // Начинаем скачивание
        await this.downloadFormat(format);
    }

    async downloadFormat(format) {
        if (this.isDownloading) return;
        this.isDownloading = true;
        
        const controller = new AbortController();
        this.downloadController = controller;
        
        try {
            updateStatus('Starting download...');
            
            const response = await fetch(format.url, {
                signal: controller.signal,
                mode: 'cors',
                credentials: 'omit'
            });
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const contentLength = +response.headers.get('content-length');
            let loaded = 0;
            const chunks = [];
            const reader = response.body.getReader();
            
            const startTime = Date.now();
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                chunks.push(value);
                loaded += value.length;
                
                // Обновляем прогресс
                const percent = contentLength ? (loaded / contentLength * 100) : 0;
                this.updateProgress(percent, loaded, startTime);
            }
            
            // Создаем Blob
            const blob = new Blob(chunks);
            
            // Постобработка если нужно
            let finalBlob = blob;
            if (document.getElementById('convertToMp3').checked) {
                finalBlob = await this.convertToMp3(blob);
            }
            
            // Сохраняем файл
            this.saveFile(finalBlob, `${this.currentInfo.title}.${finalBlob.type.split('/')[1]}`);
            
            updateStatus('Download completed');
            
        } catch (error) {
            if (error.name === 'AbortError') {
                updateStatus('Download cancelled', 'warning');
            } else {
                updateStatus(`Download failed: ${error.message}`, 'error');
            }
        } finally {
            this.isDownloading = false;
            this.downloadController = null;
        }
    }

    updateProgress(percent, loaded, startTime) {
        this.elements.progressBar.style.width = `${percent}%`;
        this.elements.progressText.textContent = `${percent.toFixed(1)}%`;
        
        // Расчет скорости
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = loaded / elapsed;
        this.elements.speedInfo.textContent = this.formatFileSize(speed) + '/s';
        
        // Оставшееся время
        if (speed > 0) {
            const remaining = (this.selectedFormat.filesize - loaded) / speed;
            this.elements.timeInfo.textContent = `${remaining.toFixed(0)}s remaining`;
        }
    }

    async convertToMp3(blob) {
        updateStatus('Converting to MP3...');
        
        const inputName = 'input.' + blob.type.split('/')[1];
        const outputName = 'output.mp3';
        
        this.ffmpeg.FS('writeFile', inputName, 
            new Uint8Array(await blob.arrayBuffer()));
        
        await this.ffmpeg.run('-i', inputName, '-q:a', '2', outputName);
        
        const data = this.ffmpeg.FS('readFile', outputName);
        return new Blob([data.buffer], { type: 'audio/mpeg' });
    }

    saveFile(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Утилиты
    formatDuration(seconds) {
        if (!seconds) return 'N/A';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
    }

    formatFileSize(bytes) {
        if (!bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    showLoading(show) {
        const btn = this.elements.fetchBtn;
        btn.disabled = show;
        btn.querySelector('.btn-text').hidden = show;
        btn.querySelector('.btn-spinner').hidden = !show;
    }

    filterFormats(filter) {
        document.querySelectorAll('.format-card').forEach(card => {
            card.style.display = 
                filter === 'all' || card.dataset.type === filter ? 
                'block' : 'none';
        });
        
        // Обновляем активную кнопку фильтра
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === filter);
        });
    }

    async fallbackToYtdlCore(url) {
        // Резервный вариант для YouTube через ytdl-core в JavaScript
        updateStatus('Using fallback extractor...');
        // Здесь можно добавить интеграцию с ytdl-core
    }
}

// Вспомогательные функции
function updateStatus(text, type = 'info') {
    const statusEl = document.getElementById('statusText');
    statusEl.textContent = text;
    statusEl.className = `status-${type}`;
    
    const pyodideStatus = document.getElementById('pyodideStatus');
    if (window.pyodideManager?.isReady) {
        pyodideStatus.textContent = 'Pyodide: Ready';
        pyodideStatus.className = 'status-indicator ready';
    }
}

// Инициализация при загрузке
document.addEventListener('DOMContentLoaded', () => {
    window.downloader = new VideoDownloader();
    
    // Предварительная загрузка Pyodide
    setTimeout(() => {
        if (!window.pyodideManager.isReady) {
            window.pyodideManager.initialize().catch(console.error);
        }
    }, 1000);
});