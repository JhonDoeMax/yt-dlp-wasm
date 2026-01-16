// ytdlp-patch.js
export async function patchYtdlp(pyodide) {
    const patchCode = `
import pyodide.http
import json
import yt_dlp
import urllib.parse
import io

# Создаем кэш для запросов
_request_cache = {}

# Используем CORS прокси для YouTube
def get_proxy_url(url):
    import urllib.parse
    # Используем публичный CORS прокси
    parsed = urllib.parse.urlparse(url)
    if 'youtube.com' in parsed.netloc or 'youtu.be' in parsed.netloc:
        # Используем CORS прокси сервер
        return f"https://corsproxy.io/?{urllib.parse.quote(url)}"
    return url

def browser_urlopen(self, request):
    global _request_cache

    # Получаем URL из объекта Request или строки
    if hasattr(request, 'url'):
        url = request.url
    else:
        url = str(request)

    cache_key = url
    if cache_key in _request_cache:
        # Возвращаем объект с методами read() и close()
        cached_content = _request_cache[cache_key]
        return io.BytesIO(cached_content.encode('utf-8'))

    try:
        # Используем проксированный URL для YouTube
        proxy_url = get_proxy_url(url)

        # Для YouTube используем специальный подход
        if 'youtube.com' in url or 'youtu.be' in url:
            # Пробуем через js.fetch с прокси
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
                        text = await response.text()
                        # Кэшируем как bytes
                        _request_cache[cache_key] = text.encode('utf-8')
                        return text.encode('utf-8')
                    else:
                        raise Exception(f"HTTP {response.status}")
                except Exception as e2:
                    print(f"JS fetch failed: {e2}")
                    # Пробуем альтернативный прокси
                    alt_proxy = f"https://api.allorigins.win/raw?url={urllib.parse.quote(url)}"
                    response2 = await js.fetch(alt_proxy, {"mode": "cors"})
                    if response2.status == 200:
                        text = await response2.text()
                        _request_cache[cache_key] = text.encode('utf-8')
                        return text.encode('utf-8')
                    raise

            from asyncio import run
            result = run(fetch_async())
            if result:
                # Возвращаем BytesIO объект с read() методом
                return io.BytesIO(result)
            raise Exception("All fetch attempts failed")
        else:
            # Для других сайтов используем стандартный метод
            response = pyodide.http.open_url(proxy_url)
            content = response.read()
            response.close()

            if isinstance(content, bytes):
                _request_cache[cache_key] = content
            else:
                _request_cache[cache_key] = content.encode('utf-8')

            return io.BytesIO(_request_cache[cache_key])

    except Exception as e:
        import sys
        print(f"URL fetch error for {url}: {e}", file=sys.stderr)
        # Создаем пустой BytesIO объект для совместимости
        return io.BytesIO(b'')

# Создаем кастомный класс для браузера
class BrowserYoutubeDL(yt_dlp.YoutubeDL):
    def urlopen(self, request):
        return browser_urlopen(self, request)

print("✅ yt-dlp patched for browser environment with CORS proxy")
`;

    try {
        await pyodide.runPythonAsync(patchCode);
        console.log("yt-dlp patched successfully");
    } catch (error) {
        console.error("Failed to patch yt-dlp:", error);
        throw error;
    }
}