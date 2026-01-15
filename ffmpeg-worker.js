// ffmpeg-worker.js
self.addEventListener('message', async (e) => {
    const { type, data } = e.data;
    
    if (type === 'CONVERT_TO_MP3') {
        const { blob } = data;
        // Конвертация в MP3
        const result = await convertAudio(blob);
        self.postMessage({ type: 'CONVERSION_DONE', result });
    }
});