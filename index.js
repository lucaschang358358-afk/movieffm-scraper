const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.lucas.ncatscraper",
    version: "1.0.3",
    name: "網飞貓 (NCat) 直連外掛 (極速直擊版)",
    description: "透過極速無渲染模式直接向 ncat21.com 索取 m3u8 影片源",
    catalogs: [], 
    resources: ["stream"],
    types: ["movie"],
    idPrefixes: ["tt"]
});

const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.ncat21.com/"
};

// 極速連線函數：拿掉 render，用純 API 請求拼速度
async function fetchViaScraper(targetUrl, method = "GET", payload = null) {
    const config = {
        method: method,
        timeout: 35000, 
        data: payload,
        headers: baseHeaders
    };

    if (process.env.SCRAPER_API_KEY) {
        config.url = "http://api.scraperapi.com";
        config.params = {
            api_key: process.env.SCRAPER_API_KEY,
            url: targetUrl,
            keep_headers: "true",
            premium: "true"
            // 不開 render，避免雲端瀏覽器拖慢幾十秒
        };
    } else {
        config.url = targetUrl;
    }

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("強制逾時：連線過久")), 36000)
    );

    return Promise.race([axios(config), timeoutPromise]);
}

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };

    try {
        console.log(`\n[1] 收到 Nuvio 請求，IMDB ID: ${id}`);
        
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
        console.log(`[2] 準備在網飛貓極速搜尋: ${searchKeyword}`);

        // --- 階段 B: 搜尋並獲取播放頁面網址 ---
        const searchUrl = `https://www.ncat21.com/search?k=${encodeURIComponent(searchKeyword)}`;
        const searchRes = await fetchViaScraper(searchUrl, "GET");
        
        const html = searchRes.data || "";
        
        // 抓取 /detail/數字.html 或 /detail/2/數字.html
        const detailUrlMatch = html.match(/href="(\/detail\/[^"]+\.html)"/i) || html.match(/href="(\/play\/[^"]+\.html)"/i);
        
        if (!detailUrlMatch) {
            console.log(`[警告] 找不到該電影的詳情頁連結`);
            return { streams: [] };
        }
        
        const detailPath = detailUrlMatch[1];
        const fullDetailUrl = `https://www.ncat21.com${detailPath}`;
        console.log(`[3] 成功鎖定專屬頁面: ${fullDetailUrl}`);

        // --- 階段 C: 進入專屬頁面，直接挖 m3u8 ---
        console.log(`[4] 抓取詳情頁原始碼中...`);
        const detailRes = await fetchViaScraper(fullDetailUrl, "GET");
        const detailHtml = detailRes.data || "";
        
        // 直接用正則表達式把 m3u8 抓出來
        const m3u8Match = detailHtml.match(/src:\s*"(https?:\/\/[^"]+\.m3u8)"/i) || detailHtml.match(/(https?:\/\/[^"'\s\\]+\.m3u8)/i);
        
        if (!m3u8Match) {
            throw new Error("頁面中未找到 m3u8 影片源");
        }
        
        const streamUrl = m3u8Match[1].replace(/\\\//g, '/');
        console.log(`[5] 成功抓取網飛貓片源: ${streamUrl}`);

        return {
            streams: [
                {
                    url: streamUrl,
                    title: `網飛貓 直連\n(極速直擊)`,
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
