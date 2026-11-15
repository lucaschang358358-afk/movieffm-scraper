const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.lucas.movieffmscraper",
    version: "1.0.9",
    name: "MovieFFM 直連外掛 (暴力盲狙版)",
    description: "跳過網頁載入，直接模擬播放按鈕打 API 獲取資源",
    catalogs: [], 
    resources: ["stream"],
    types: ["movie"],
    idPrefixes: ["tt"]
});

const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.mvffm.net/"
};

// 核心連線函數，超時設為 15 秒
async function fetchViaScraper(targetUrl, method = "GET", payload = null) {
    const config = {
        method: method,
        timeout: 15000, 
        data: payload,
        headers: payload ? { "Content-Type": "application/x-www-form-urlencoded", ...baseHeaders } : baseHeaders
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
        // 拿掉 render: true，因為我們不讀網頁了，直接打 API 速度更快
    };
    return axios(config);
}

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };

    try {
        console.log(`\n[1] 收到 Nuvio 請求，IMDB ID: ${id}`);
        
        // 1. 取得中英文片名
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
        console.log(`[2] 鎖定目標片名: ${searchKeyword}`);

        // 3. 暴力盲狙：不進網頁找 ID 了！直接假裝是播放按鈕，向 admin-ajax.php 要資源
        // 利用 Dooplay 主題的特性，我們可以嘗試用標題去搜刮 live_search 或是直接帶入參數
        const ajaxTargetUrl = "https://www.mvffm.net/wp-admin/admin-ajax.php";
        
        // 這邊組合了幾種常見的盲狙參數，利用標題去撞出 iframe
        const ajaxPayload = `action=doo_player_ajax&post=${encodeURIComponent(searchKeyword)}&nume=1&type=movie`;
        
        console.log(`[3] 繞過網頁載入，直接向 API 討影片...`);
        const ajaxRes = await fetchViaScraper(ajaxTargetUrl, "POST", ajaxPayload);

        // 4. 解析回傳的 m3u8
        let streamUrl = "";
        const responseData = typeof ajaxRes.data === 'string' ? ajaxRes.data : JSON.stringify(ajaxRes.data);
        
        const m3u8Match = responseData.match(/(https?:\/\/[^"'\s\\]+\.m3u8)/);
        if (m3u8Match) {
            streamUrl = m3u8Match[1];
        } else {
            const iframeMatch = responseData.match(/src=["']?\\?(https?:\/\/[^"'\\]+)["']?/);
            if (iframeMatch) {
                let iframeUrl = iframeMatch[1].replace(/\\\//g, '/');
                console.log(`[4] 發現隱藏 iframe: ${iframeUrl}`);
                const iframeRes = await fetchViaScraper(iframeUrl, "GET");
                const deepM3u8 = iframeRes.data.match(/(https?:\/\/[^"'\s]+\.m3u8)/);
                if (deepM3u8) streamUrl = deepM3u8[1];
            }
        }

        if (!streamUrl) throw new Error("盲狙失敗，API 未回傳有效的影片網址");
        console.log(`[5] 成功取得片源: ${streamUrl}`);

        return {
            streams: [
                {
                    url: streamUrl,
                    title: `MovieFFM 直連\n(暴力盲狙版)`,
                    behaviorHints: { notWebReady: false }
                }
            ]
        };
    } catch (error) {
        console.error("抓取失敗或連線超時:", error.message);
        return { streams: [] };
    }
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: port });
console.log(`外掛已啟動於 Port ${port}`);
