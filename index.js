const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.lucas.ncatscraper",
    version: "1.0.1",
    name: "網飞貓 (NCat) 直連外掛",
    description: "自動從 ncat21.com 搜尋並刮取 m3u8 高清片源",
    catalogs: [], 
    resources: ["stream"],
    types: ["movie"],
    idPrefixes: ["tt"]
});

const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.ncat21.com/"
};

// 代理連線函數 (網飛貓通常不擋家用 IP，但 Render 雲端 IP 容易被擋，所以還是掛著 Scraper)
async function fetchViaScraper(targetUrl, method = "GET", payload = null) {
    const config = {
        method: method,
        timeout: 15000, 
        data: payload,
        headers: baseHeaders
    };

    if (!process.env.SCRAPER_API_KEY) {
        config.url = targetUrl;
        return axios(config);
    }

    config.url = "http://api.scraperapi.com";
    config.params = {
        api_key: process.env.SCRAPER_API_KEY,
        url: targetUrl,
        keep_headers: "true",
        premium: "true"
    };
    return axios(config);
}

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };

    try {
        console.log(`\n[1] 收到 Nuvio 請求，IMDB ID: ${id}`);
        
        // --- 階段 A: 翻譯片名 ---
        let tmdbTitle = "";
        let cinemetaTitle = "";

        if (process.env.TMDB_API_KEY) {
            const tmdbUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${process.env.TMDB_API_KEY}&external_source=imdb_id&language=zh-TW`;
            const tmdbRes = await axios.get(tmdbUrl, { timeout: 3000 }).catch(() => null);
            tmdbTitle = tmdbRes?.data?.movie_results?.[0]?.title || "";
        }
        
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`, { timeout: 3000 }).catch(() => null);
        cinemetaTitle = metaRes?.data?.meta?.name || "";

        if (!tmdbTitle && !cinemetaTitle) throw new Error("無法解析電影名稱");
        
        const searchKeyword = tmdbTitle || cinemetaTitle;
        console.log(`[2] 準備在網飛貓搜尋: ${searchKeyword}`);

        // --- 階段 B: 搜尋並獲取播放頁面網址 ---
        // 網飛貓的搜尋參數是 k
        const searchUrl = `https://www.ncat21.com/search?k=${encodeURIComponent(searchKeyword)}`;
        const searchRes = await fetchViaScraper(searchUrl, "GET");
        
        const html = searchRes.data || "";
        
        // 從搜尋結果挖出第一部電影的播放連結，通常是 /detail/2/2549.html 或 /play/xxxx.html
        // 尋找類似 <a href="/detail/xxx.html" title="電影名稱"> 的標籤
        const detailUrlMatch = html.match(/href="(\/detail\/[^"]+\.html)"/i) || html.match(/href="(\/play\/[^"]+\.html)"/i);
        
        if (!detailUrlMatch) {
            throw new Error(`在網飛貓找不到這部電影: ${searchKeyword}`);
        }
        
        const detailPath = detailUrlMatch[1];
        const fullDetailUrl = `https://www.ncat21.com${detailPath}`;
        console.log(`[3] 找到電影專屬頁面: ${fullDetailUrl}`);

        // --- 階段 C: 進入專屬頁面，直接挖 m3u8 ---
        const detailRes = await fetchViaScraper(fullDetailUrl, "GET");
        const detailHtml = detailRes.data || "";
        
        // 根據你提供的原始碼，網飛貓直接把網址寫在 src: "..." 裡面
        const m3u8Match = detailHtml.match(/src:\s*"(https?:\/\/[^"]+\.m3u8)"/i) || detailHtml.match(/(https?:\/\/[^"'\s\\]+\.m3u8)/i);
        
        if (!m3u8Match) {
            throw new Error("在播放頁面中找不到 m3u8 連結，可能是防護或格式變更");
        }
        
        const streamUrl = m3u8Match[1].replace(/\\\//g, '/');
        console.log(`[4] 成功扒出網飛貓片源: ${streamUrl}`);

        return {
            streams: [
                {
                    url: streamUrl,
                    title: `網飛貓 直連\n(無敵秒播)`,
                    behaviorHints: { notWebReady: false }
                }
            ]
        };
    } catch (error) {
        console.error("抓取失敗:", error.message);
        return { streams: [] };
    }
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: port });
console.log(`網飛貓外掛已啟動於 Port ${port}`);
